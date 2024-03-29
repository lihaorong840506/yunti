import { Injectable, Logger } from '@nestjs/common';
import { merge } from 'lodash';

import { AppsMembersService } from '@/apps-members/apps-members.service';
import { Page } from '@/common/entities/pages.entity';
import { MemberRole } from '@/common/models/member-role.enum';
import treeDataSources from '@/common/tree-data-sources';
import { CustomException, checkUserTreeMutationPermision, genNanoid } from '@/common/utils';
import { GitService } from '@/git/git.service';
import { MergeRequestService } from '@/merge-requests/merge-requests.service';
import { ILoginUser } from '@/types';

import { NewPageInput } from './dtos/new-page.input';
import { UpdatePageInput } from './dtos/update-page.input';
import PageSchema from './templates/schema';

@Injectable()
export class PagesService {
  constructor(
    private readonly gitService: GitService,
    private readonly appsMembersService: AppsMembersService,
    private readonly mergeRequestService: MergeRequestService
  ) {}

  logger = new Logger('PagesService');

  getPagesRepository = (tree: string) => treeDataSources.getRepository<Page>(tree, Page);

  async createPage(tree: string, loginUser: ILoginUser, body: NewPageInput) {
    const memberRole = await this.appsMembersService.checkUserAppMemberRole(loginUser, body.appId, {
      not: [MemberRole.Guest, MemberRole.Reporter],
    });
    checkUserTreeMutationPermision(loginUser, tree, memberRole, body.appId);
    const status = await this.gitService.getStatus(tree, Page.tableName);
    if (status) {
      throw new CustomException(
        'COMMIT_CHANGES_FIRST',
        'please commit your changes of page first',
        400
      );
    }
    const { fileName, contentFrom, ...page } = body;
    const pagesRepository = await this.getPagesRepository(tree);
    const id = genNanoid('page');
    if (contentFrom) {
      const { pageId, templateId } = contentFrom;
      if (pageId) {
        const contentFromPage = await pagesRepository.findOneBy({ id: pageId });
        page.content = contentFromPage.content;
      } else if (templateId) {
        // @Todo: support template
      }
    }

    const content = merge({}, PageSchema, page.content || {});
    content.componentsTree[0].id = id;
    content.componentsTree[0].meta = content.componentsTree[0].meta || {
      title: '',
      router: '',
    };
    content.componentsTree[0].meta.title = page.title;
    content.componentsTree[0].meta.router = page.pathname;
    content.componentsTree[0].fileName = fileName;

    const newPage = {
      ...page,
      content,
      id,
    };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await pagesRepository.insert(newPage);
    await this.gitService.commitNt(tree, {
      committer: loginUser,
      tables: [Page.tableName],
      message: `Create page ${body.title}(${id})`,
    });
    return pagesRepository.findOneBy({ id });
  }

  async updatePage(tree: string, loginUser: ILoginUser, body: UpdatePageInput) {
    const pagesRepository = await this.getPagesRepository(tree);
    const { id, fileName, ...page } = body;
    // @Todo: id 为 undefined 时查询可以返回结果，这个不太对
    const oldPage = await pagesRepository.findOneBy({ id });

    const content =
      (page.content &&
        Array.isArray(page.content.componentsTree) &&
        page.content.componentsTree.length > 0 &&
        page.content) ||
      oldPage.content;
    content.componentsTree[0].id = id;
    content.componentsTree[0].meta.title = page.title || oldPage.title;
    content.componentsTree[0].meta.router = page.pathname || oldPage.pathname;
    content.componentsTree[0].fileName = fileName || oldPage.content.componentsTree?.[0]?.fileName;
    page.content = content;

    const memberRole = await this.appsMembersService.checkUserAppMemberRole(
      loginUser,
      oldPage.appId,
      {
        not: [MemberRole.Guest, MemberRole.Reporter],
      }
    );
    checkUserTreeMutationPermision(loginUser, tree, memberRole, oldPage.appId);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    await pagesRepository.update(id, page);
    return pagesRepository.findOneBy({ id });
  }

  async getPageById(tree: string, loginUser: ILoginUser, id: string): Promise<Page> {
    const pagesRepository = await this.getPagesRepository(tree);
    const page = await pagesRepository.findOneBy({ id });
    if (!page) {
      return;
    }
    await this.appsMembersService.checkUserAppMemberRole(loginUser, page.appId);
    return page;
  }

  async getAppPages(tree: string, loginUser: ILoginUser, appId: string): Promise<Page[]> {
    const pagesRepository = await this.getPagesRepository(tree);
    await this.appsMembersService.checkUserAppMemberRole(loginUser, appId);
    const pages = await pagesRepository.find({
      where: { appId },
    });
    return pages;
  }

  async deletePage(tree: string, loginUser: ILoginUser, id: string) {
    const pagesRepository = await this.getPagesRepository(tree);
    const page = await pagesRepository.findOneBy({ id });
    const memberRole = await this.appsMembersService.checkUserAppMemberRole(loginUser, page.appId, {
      not: [MemberRole.Guest, MemberRole.Reporter],
    });
    checkUserTreeMutationPermision(loginUser, tree, memberRole, page.appId);
    const status = await this.gitService.getStatus(tree, Page.tableName);
    if (status) {
      throw new CustomException(
        'COMMIT_CHANGES_FIRST',
        'please commit your changes of page first',
        400
      );
    }
    const res = await pagesRepository.delete(id);
    await this.gitService.commitNt(tree, {
      committer: loginUser,
      tables: [Page.tableName],
      message: `Delete page ${id}.`,
    });
    await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
    return res;
  }

  async commitPage(tree: string, loginUser: ILoginUser, id: string, message: string) {
    const pagesRepository = await this.getPagesRepository(tree);
    const page = await pagesRepository.findOneBy({ id });
    const memberRole = await this.appsMembersService.checkUserAppMemberRole(loginUser, page.appId, {
      not: [MemberRole.Guest, MemberRole.Reporter],
    });
    checkUserTreeMutationPermision(loginUser, tree, memberRole, page.appId);
    const status = await this.gitService.getStatus(tree, Page.tableName);
    if (!status) {
      throw new CustomException('NOTHING_TO_COMMIT', 'nothing to commit, working tree clean', 400);
    }
    const commitResult = await this.gitService.commitNt(tree, {
      committer: loginUser,
      tables: [Page.tableName],
      message: `Update page ${id}: ${message}`,
    });
    await this.mergeRequestService.refreshMergeRequest(loginUser, tree);
    return commitResult;
  }
}
