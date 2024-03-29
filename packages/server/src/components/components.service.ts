import {
  IPublicTypeAssetsJson,
  IPublicTypeLowCodeComponent,
  IPublicTypeProCodeComponent,
} from '@alilc/lowcode-types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { merge } from 'lodash';

import { UpdateSchemaI18nArgs } from '@/common/dto/update-schema-i18n.args';
import { ComponentMember } from '@/common/entities/components-members.entity';
import { ComponentVersion } from '@/common/entities/components-versions.entity';
import { Component, I18nUsage } from '@/common/entities/components.entity';
import { MemberRole } from '@/common/models/member-role.enum';
import treeDataSources from '@/common/tree-data-sources';
import {
  CustomException,
  TREE_DEFAULT,
  checkUserTreeMutationPermision,
  extractI18nKeyPathFromSchema,
  genNanoid,
} from '@/common/utils';
import { ComponentsMembersService } from '@/components-members/components-members.service';
import { ComponentsVersionsService } from '@/components-versions/components-versions.service';
import serverConfig from '@/config/server.config';
import { GitService } from '@/git/git.service';
import { MergeRequestService } from '@/merge-requests/merge-requests.service';
import { sortPackages } from '@/packages/utils';
import { ILoginUser } from '@/types';

import { NewComponentInput } from './dtos/new-component.input';
import { ReleaseComponentInput } from './dtos/release-component.input';
import { UpdateComponentInput } from './dtos/update-component.input';
import * as defaultAssets from './templates/assets.json';
import * as defaultSchema from './templates/schema.json';

@Injectable()
export class ComponentsService {
  constructor(
    @Inject(serverConfig.KEY)
    private config: ConfigType<typeof serverConfig>,
    private readonly gitService: GitService,
    private readonly componentsMembersService: ComponentsMembersService,
    private readonly componentsVersionsService: ComponentsVersionsService,
    private readonly mergeRequestService: MergeRequestService
  ) {}
  logger = new Logger('ComponentsService');

  getComponentsRepository = (tree: string) =>
    treeDataSources.getRepository<Component>(tree, Component);

  async listComponents(tree: string): Promise<Component[]> {
    const componentsRepository = await this.getComponentsRepository(tree);
    return componentsRepository.find({
      order: {
        createAt: 'DESC',
      },
    });
  }

  async getComponentById(tree: string, user: ILoginUser, id: string): Promise<Component> {
    await this.componentsMembersService.checkUserComponentMemberRole(user, id);
    const componentsRepository = await this.getComponentsRepository(tree);
    const component = await componentsRepository.findOne({
      where: { id },
      order: {
        versions: {
          version: 'DESC',
        },
      },
      relations: {
        versions: true,
      },
    });
    if (!component.versions) {
      component.versions = [];
    }
    // @Todo 后面最好提供单独的字段获取资产，每次获取详情的时候都处理的话可能会导致加载速度变慢
    component.assets = await this.componentsVersionsService.improveAndSortAssets(component.assets);
    // @Todo 目前低代码组件的生命周期需要定义到 methods 中，否则无法执行
    // 相关 bug：https://github.com/alibaba/lowcode-engine/issues/1081#issuecomment-1257955293
    if (component.schema?.componentsTree?.[0]?.lifeCycles) {
      Object.assign(
        component.schema.componentsTree[0].methods,
        component.schema.componentsTree[0].lifeCycles
      );
    }
    return component;
  }

  async createComponent(tree: string, user: ILoginUser, body: NewComponentInput) {
    const dataSource = await treeDataSources.getDataSource(tree);
    const queryRunner = dataSource.createQueryRunner();
    const id = genNanoid('component');

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const { name, namespace, description, fileName, schema: schemaDto, assets } = body;
      const component = new Component();
      component.id = id;
      component.name = name;
      component.description = description;
      component.assets = assets || (defaultAssets as unknown as IPublicTypeAssetsJson);
      const schema = merge({}, defaultSchema, schemaDto, {
        meta: { name, namespace, description, version: '0.1.0' },
      });
      schema.componentsTree[0].id = id;
      schema.componentsTree[0].fileName = fileName;
      component.schema = schema;
      await queryRunner.manager.save(component);

      const componentMember = new ComponentMember();
      componentMember.role = MemberRole.Owner;
      componentMember.member = user;
      componentMember.component = component;
      await queryRunner.manager.save(componentMember);

      // 提交 commit
      await this.gitService.commit({
        committer: user,
        tables: [Component.tableName, ComponentMember.tableName],
        message: `Create component ${body.name}(${id}).`,
        queryRunner,
      });

      // 创建默认分支
      await this.gitService.DOLT_BRANCH([`${id}/${TREE_DEFAULT}`], queryRunner);

      await queryRunner.commitTransaction();
    } catch (error) {
      // since we have errors lets rollback the changes we made
      this.logger.error('createComponent failed', error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // you need to release a queryRunner which was manually instantiated
      await queryRunner.release();
    }

    const componentsRepository = await this.getComponentsRepository(tree);
    return componentsRepository.findOne({
      where: { id },
      order: {
        members: {
          createAt: 'DESC',
        },
      },
      relations: {
        members: true,
      },
    });
  }

  async updateComponent(tree: string, loginUser: ILoginUser, body: UpdateComponentInput) {
    const { id, fileName, ...updateComponentInput } = body;
    const memberRole = await this.componentsMembersService.checkUserComponentMemberRole(
      loginUser,
      id,
      {
        not: [MemberRole.Guest, MemberRole.Reporter],
      }
    );
    checkUserTreeMutationPermision(loginUser, tree, memberRole, id);

    const componentsRepository = await this.getComponentsRepository(tree);

    const log = await this.gitService.listLog(tree, { take: 2 });
    const updateComponentKeys = Object.keys(updateComponentInput).sort();
    const message = `Update component ${id}: ${updateComponentKeys.join(', ')}`;

    const dataSource = await treeDataSources.getDataSource(tree);
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      if (
        log.length === 2 &&
        log[0]?.message === message &&
        Date.now() - log[0].date < 1000 * 60 * (this.config.commit?.reset_minutes || 10)
      ) {
        await this.gitService.DOLT_RESET(['--soft', log[1].hash], queryRunner);
      }
      // 保存当前修改
      const component = new Component();
      component.id = id;
      merge(component, updateComponentInput);
      if (
        fileName ||
        updateComponentInput.name ||
        updateComponentInput.description ||
        updateComponentInput.schema ||
        updateComponentInput.assets
      ) {
        const oldComponent = await componentsRepository.findOneBy({ id });
        const namespace =
          oldComponent.schema?.meta?.namespace || updateComponentInput.name || oldComponent.name;
        const schema = updateComponentInput.schema || oldComponent.schema;
        merge(schema, {
          meta: {
            name: updateComponentInput.name || oldComponent.name,
            namespace,
            description: updateComponentInput.description || oldComponent.description,
            version: schema?.version || oldComponent.schema?.version,
          },
        });
        schema.componentsTree[0].fileName =
          fileName || oldComponent.schema.componentsTree?.[0]?.fileName;

        if (updateComponentInput.assets) {
          // 对 assets 中的 packages 进行排序
          component.assets.packages = sortPackages(updateComponentInput.assets.packages, 'package');
          // 更新 schema 中 componentsMap 的 npm 版本
          if (schema.componentsMap)
            for (const cm of schema.componentsMap) {
              if ((cm as IPublicTypeLowCodeComponent).devMode !== 'lowCode') {
                const targetPkg = updateComponentInput.assets.packages.find(
                  pkg => pkg.package === (cm as IPublicTypeProCodeComponent).package
                );
                if (targetPkg) {
                  (cm as IPublicTypeProCodeComponent).version = targetPkg.version;
                }
              }
            }
          // 更新 schema 中 utils 的 npm 版本
          if (schema.utils)
            for (const util of schema.utils) {
              if (util.type === 'npm') {
                const targetPkg = updateComponentInput.assets.packages.find(
                  pkg => pkg.package === util.content.package
                );
                if (targetPkg) {
                  util.content.version = targetPkg.version;
                }
              }
            }
        }
        component.schema = schema;
      }
      await queryRunner.manager.save(component);

      // 提交修改
      await this.gitService.commit({
        queryRunner,
        committer: loginUser,
        tables: [Component.tableName],
        message,
      });

      await queryRunner.commitTransaction();
      await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
    } catch (error) {
      // since we have errors lets rollback the changes we made
      this.logger.error(`${message} failed`, error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // you need to release a queryRunner which was manually instantiated
      await queryRunner.release();
    }

    const newComponent = await componentsRepository.findOneBy({ id });
    // @Todo 后面最好提供单独的字段获取资产，每次获取详情的时候都处理的话可能会导致加载速度变慢
    newComponent.assets = await this.componentsVersionsService.improveAndSortAssets(
      newComponent.assets
    );
    return newComponent;
  }

  async updateComponentI18n(tree: string, loginUser: ILoginUser, args: UpdateSchemaI18nArgs) {
    const { id, i18n } = args;
    const memberRole = await this.componentsMembersService.checkUserComponentMemberRole(
      loginUser,
      id,
      {
        not: [MemberRole.Guest, MemberRole.Reporter],
      }
    );
    checkUserTreeMutationPermision(loginUser, tree, memberRole, id);

    const componentsRepository = await this.getComponentsRepository(tree);
    const oldComponent = await componentsRepository.findOneBy({ id });
    const { schema } = oldComponent;
    schema.i18n = i18n;

    const log = await this.gitService.listLog(tree, { take: 2 });
    const message = `Update component ${id} i18n`;

    const dataSource = await treeDataSources.getDataSource(tree);
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // 由于 i18n 更新比较频繁，为了减少 commit 数量，这里会判断最新的 commit 如果也是更新 i18n 而且
      // 提交时间在 10 分钟（默认时间，可配置）内的话，会做回退操作，新的 commit 中会包含所有修改
      if (
        log.length === 2 &&
        log[0]?.message === message &&
        Date.now() - log[0].date < 1000 * 60 * (this.config.commit?.reset_minutes || 10)
      ) {
        await this.gitService.DOLT_RESET(['--soft', log[1].hash], queryRunner);
      }

      // 保存当前修改
      const component = new Component();
      component.id = id;
      component.schema = schema;
      await queryRunner.manager.save(component);

      // 提交修改
      await this.gitService.commit({
        queryRunner,
        committer: loginUser,
        tables: [Component.tableName],
        message,
      });

      await queryRunner.commitTransaction();
      await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
    } catch (error) {
      // since we have errors lets rollback the changes we made
      this.logger.error(`${message} failed`, error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // you need to release a queryRunner which was manually instantiated
      await queryRunner.release();
    }

    const newComponent = await componentsRepository.findOneBy({ id });
    return newComponent.schema.i18n;
  }

  async getI18nUsage(component: Component) {
    const i18nUsage: I18nUsage = {};

    const addKeyToI18n = (key: string, path: string[]) => {
      if (!i18nUsage[key]) {
        i18nUsage[key] = [path];
        return;
      }
      i18nUsage[key].push(path);
    };
    extractI18nKeyPathFromSchema(component.schema, [], addKeyToI18n);
    return i18nUsage;
  }

  async commitComponent(tree: string, loginUser: ILoginUser, id: string, message: string) {
    const componentsRepository = await this.getComponentsRepository(tree);
    const component = await componentsRepository.findOneBy({ id });
    await this.componentsMembersService.checkUserComponentMemberRole(loginUser, component.id, {
      not: [MemberRole.Guest, MemberRole.Reporter],
    });
    const status = await this.gitService.getStatus(tree, Component.tableName);
    if (!status) {
      throw new CustomException('NOTHING_TO_COMMIT', 'nothing to commit, working tree clean', 400);
    }
    const commitResult = await this.gitService.commitNt(tree, {
      committer: loginUser,
      tables: [Component.tableName, ComponentVersion.tableName],
      message: `Update component ${id}: ${message}`,
    });
    await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
    return commitResult;
  }

  async releaseComponent(tree: string, loginUser: ILoginUser, release: ReleaseComponentInput) {
    const { componentId, version, description, force } = release;
    const componentsRepository = await this.getComponentsRepository(tree);
    const component = await componentsRepository.findOneBy({ id: componentId });
    let message = `release ${component.name}@${version}`;
    if (description) {
      message += `=> ${description}`;
    }

    // ~ 检查当前用户是否有权限发版
    const memberRole = await this.componentsMembersService.checkUserComponentMemberRole(
      loginUser,
      component.id,
      {
        must: [MemberRole.Maintainer, MemberRole.Owner],
      }
    );
    checkUserTreeMutationPermision(loginUser, tree, memberRole, component.id);

    // ~ 检查是否允许覆盖发版
    if (
      !force &&
      (await this.componentsVersionsService.getComponentVersion(TREE_DEFAULT, componentId, version))
    ) {
      throw new CustomException('COMPONENT_VERSION_EXIST', `${message} failed, version exist`, 409);
    }

    // 组件版本需要发布到 main 分支上
    const dataSource = await treeDataSources.getDataSource(TREE_DEFAULT);
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // ~ 获取最新的 commit id
      let commitId = '';
      const status = await this.gitService.getStatus(tree, Component.tableName);
      if (status) {
        const { hash } = await this.gitService.commitNt(tree, {
          committer: loginUser,
          tables: [Component.tableName],
          message: `${Component.tableName}: ${message}`,
        });
        commitId = hash;
        await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
      } else {
        const logs = await this.gitService.listLog(tree, { take: 1 });
        commitId = logs[0].hash;
      }

      // ~ 创建版本
      const componentVersion = new ComponentVersion();
      componentVersion.commitId = commitId;
      componentVersion.version = version;
      componentVersion.description = description;
      componentVersion.component = component;
      componentVersion.componentId = component.id;
      await queryRunner.manager.save(componentVersion);

      // ~ 提交创建版本的修改
      await this.gitService.commit({
        committer: loginUser,
        tables: [ComponentVersion.tableName],
        message: `${ComponentVersion.tableName}: ${message}`,
        queryRunner,
      });

      await queryRunner.commitTransaction();
      await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
      return componentVersion;
    } catch (error) {
      this.logger.error(`${message} failed =>`, error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      this.logger.log(message);
      await queryRunner.release();
    }
  }
}
