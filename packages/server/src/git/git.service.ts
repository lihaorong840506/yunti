/* eslint-disable no-param-reassign */

/* eslint-disable unicorn/no-array-callback-reference */
import { Injectable, Logger } from '@nestjs/common';
import { FindManyOptions, Like, QueryRunner } from 'typeorm';

import { Branch } from '@/common/entities/git/branches.entity';
import { Commit, PaginatedCommits } from '@/common/entities/git/commits.entity';
import { HistoryApp } from '@/common/entities/git/history-apps.entity';
import { HistoryComponent } from '@/common/entities/git/history-components.entity';
import { HistoryPage } from '@/common/entities/git/history-pages.entity';
import { Log, PaginatedLog } from '@/common/entities/git/log.entity';
import { Status } from '@/common/entities/git/status.entity';
import { Tag } from '@/common/entities/git/tags.entity';
import treeDataSources from '@/common/tree-data-sources';
import { RELEASE_BRANCH_PREFIX, TREE_DEFAULT, YUNTI_SERVER_COMMITTER } from '@/common/utils';
import { DataDiff, DiffData, SchemaDiff } from '@/merge-requests/models/merge-request-detail.model';
import { ILoginUser } from '@/types';

import { AppCommitsOptions } from './dto/app-commits.args';
import { CommitsArgs } from './dto/commits.args';
import { CommitResult } from './models/commit-result.model';

const FROM = 'from_';
const TO = 'to_';
const COMMIT_COLUMN = 'commit';
const COMMIT_DATE_COLUMN = 'commit_date';

export interface CommitNtOptions {
  /** 提交者，不传则为系统账户 */
  committer?: ILoginUser;
  /** 相关表 */
  tables: string[];
  /** 信息 */
  message: string;
}

export interface CommitOptions extends CommitNtOptions {
  /** sql 执行器 */
  queryRunner: QueryRunner;
}

@Injectable()
export class GitService {
  logger = new Logger('GitService');

  getCommitRepository = (tree: string) => treeDataSources.getRepository<Commit>(tree, Commit);

  getLogRepository = (tree: string) => treeDataSources.getRepository<Log>(tree, Log);

  getBranchesRepository = (tree = 'main') => treeDataSources.getRepository<Branch>(tree, Branch);

  getTagsRepository = (tree = 'main') => treeDataSources.getRepository<Tag>(tree, Tag);

  getStatusRepository = (tree: string) => treeDataSources.getRepository<Status>(tree, Status);

  getHistoryAppsRepository = (tree: string) =>
    treeDataSources.getRepository<HistoryApp>(tree, HistoryApp);

  getHistoryPagesRepository = (tree: string) =>
    treeDataSources.getRepository<HistoryPage>(tree, HistoryPage);

  getHistoryComponentsRepository = (tree: string) =>
    treeDataSources.getRepository<HistoryComponent>(tree, HistoryComponent);

  async getCommitById(tree: string, id: string) {
    const commitRepository = await this.getCommitRepository(tree);
    return commitRepository.findOneBy({ hash: id });
  }

  private genAppCommitsSql(search = false, count = false) {
    return `SELECT DISTINCT ${count ? 'COUNT(*) AS cnt' : 'hash, committer, email, `date`, message'}
    from(
      (
        SELECT c.commit_hash AS hash,
      c.committer AS committer,
      c.email AS email,
      c.date AS \`date\`,
          c.message AS message
        FROM dolt_commits c
          LEFT JOIN dolt_history_apps a ON a.commit_hash = c.commit_hash
        WHERE a.id = ?
      )
      UNION ALL
      (
        SELECT c.commit_hash AS hash,
          c.committer AS committer,
          c.email AS email,
          c.date AS \`date\`,
          c.message AS message
        FROM dolt_commits c
          LEFT JOIN dolt_history_pages p ON p.commit_hash = c.commit_hash
        WHERE p.app_id = ?
      )
    ) as cc
  ${
    search
      ? `WHERE cc.hash LIKE ?
  OR cc.message LIKE ?`
      : ''
  }
  ${count ? '' : 'ORDER BY `date` DESC LIMIT ? OFFSET ?'};`;
  }

  // 连续 inner join 两次的效率特别差，容易引起 dolt OOM，调研后发现可通过 union all 进行优化
  // @Todo: typeorm 不支持 union all，详见 https://github.com/typeorm/typeorm/issues/9051
  // 先通过拼接 sql 的方式实现
  async listAppPaginatedCommits(
    tree: string,
    appId: string,
    args: AppCommitsOptions
  ): Promise<PaginatedCommits> {
    if (!args) {
      args = new AppCommitsOptions();
    }
    const { page, pageSize, q } = args;
    const dataSource = await treeDataSources.getDataSource(tree);
    const search = Boolean(q && q.trim());
    const [countSql, querySql] = [
      this.genAppCommitsSql(search, true),
      this.genAppCommitsSql(search),
    ];
    const [countParams, queryParams]: any[][] = [
      [appId, appId],
      [appId, appId],
    ].map(params => {
      if (search) {
        params.push(`${q}%`, `%${q}%`);
      }
      return params;
    });
    queryParams.push(pageSize, (page - 1) * pageSize);
    const [countRes, commits] = await Promise.all([
      dataSource.query(countSql, countParams),
      dataSource.query(querySql, queryParams),
    ]);
    const totalCount = Number.parseInt(countRes[0].cnt);
    return {
      page,
      pageSize,
      totalCount,
      hasNextPage: page * pageSize < totalCount,
      nodes: commits,
    };
  }

  async listLog(tree: string, options?: FindManyOptions<Log>): Promise<Log[]> {
    const logRepository = await this.getLogRepository(tree);
    return logRepository.find(options);
  }

  async listPaginatedLog(tree: string, logArgs: CommitsArgs): Promise<PaginatedLog> {
    const logRepository = await this.getLogRepository(tree);
    if (!logArgs) {
      logArgs = new CommitsArgs();
    }
    const { page, pageSize } = logArgs;
    const [log, totalCount] = await logRepository.findAndCount({
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      page,
      pageSize,
      totalCount,
      hasNextPage: page * pageSize < totalCount,
      nodes: log,
    };
  }

  async listBranches(options?: FindManyOptions<Branch>): Promise<Branch[]> {
    const branchesRepository = await this.getBranchesRepository();
    return branchesRepository.find(options);
  }

  async listBranchesByIdPrefix(user: ILoginUser, id: string) {
    let branches = await this.listBranches({
      where: {
        name: Like(`${id}/%`),
      },
    });
    branches = branches.filter(branch => {
      branch.displayName = branch.name.replace(`${id}/`, '');
      if (
        branch.displayName === TREE_DEFAULT ||
        branch.displayName.startsWith(RELEASE_BRANCH_PREFIX)
      ) {
        return true;
      }
      const [userId, ...branchName] = branch.displayName.split('/');
      branch.displayName = branchName.join('/');
      return user.id === userId;
    });
    return branches;
  }

  async getBranchByName(name: string) {
    const branchesRepository = await this.getBranchesRepository();
    return branchesRepository.findOneBy({ name });
  }

  async listTags(options?: FindManyOptions<Tag>): Promise<Tag[]> {
    const tagsRepository = await this.getTagsRepository();
    return tagsRepository.find(options);
  }

  async listStatus(tree: string): Promise<Status[]> {
    const statusRepository = await this.getStatusRepository(tree);
    return statusRepository.find();
  }

  async getStatus(tree: string, tableName: string): Promise<Status> {
    const statusRepository = await this.getStatusRepository(tree);
    return statusRepository.findOne({
      where: { tableName },
    });
  }

  async listHistoryPages(tree: string, pageId: string, commitsArgs?: CommitsArgs) {
    const historyPagesRepository = await this.getHistoryPagesRepository(tree);
    if (!commitsArgs) {
      commitsArgs = new CommitsArgs();
    }
    const { page, pageSize } = commitsArgs;
    // @Todo:
    // dolt 表的 history 逻辑：只要表中数据发生变化，所有数据行都会生成一条 history
    // 这里会查询出来其他页面的 history，可能得 inner join 一下把其他的 history 排除掉
    const [historyPages, totalCount] = await historyPagesRepository.findAndCount({
      where: {
        id: pageId,
      },
      relations: {
        commit: true,
      },
      order: {
        commitDate: 'desc',
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      page,
      pageSize,
      totalCount,
      hasNextPage: page * pageSize < totalCount,
      nodes: historyPages,
    };
  }

  // @Todo：后面使用 typeorm 的 Query Builder 来生成 sql
  // 有问题，会把一些需要的 commit 过滤掉
  async listPagecommits(tree: string, pageId: string): Promise<Commit[]> {
    const dataSource = await treeDataSources.getDataSource(tree);
    const commits: Commit[] = await dataSource.query(`select p.id,
  p.title,
  p.pathname,
  p.commit_hash as hash,
  p.committer,
  p.email,
  p.date,
  p.message
from (
    select *
    from dolt_history_pages hp
      full outer join dolt_commits c on hp.commit_hash = c.commit_hash
    where id = '${pageId}'
  ) p
  left join (
    select *
    from dolt_history_pages
    where id != '${pageId}'
  ) lp on p.commit_hash = lp.commit_hash
where lp.commit_hash is null
order by p.date desc;`);
    return commits;
  }

  async listHistoryComponents(tree: string, componentId: string, commitsArgs?: CommitsArgs) {
    const historyComponetsRepository = await this.getHistoryComponentsRepository(tree);
    if (!commitsArgs) {
      commitsArgs = new CommitsArgs();
    }
    const { page, pageSize } = commitsArgs;
    // @Todo:
    // dolt 表的 history 逻辑：只要表中数据发生变化，所有数据行都会生成一条 history
    // 这里会查询出来其他页面的 history，可能得 inner join 一下把其他的 history 排除掉
    const [historyComponents, totalCount] = await historyComponetsRepository.findAndCount({
      where: {
        id: componentId,
      },
      relations: {
        commit: true,
      },
      order: {
        commitDate: 'desc',
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      page,
      pageSize,
      totalCount,
      hasNextPage: page * pageSize < totalCount,
      nodes: historyComponents,
    };
  }

  getAuthor = (committer?: ILoginUser) => {
    if (!committer) {
      return YUNTI_SERVER_COMMITTER;
    }
    const { name, email } = committer;
    return `${name} <${email}>`;
  };

  getSqlArrayParam = (array: string[]) => array.map(t => `'${t}'`).join(', ');

  /** 提交：使用传过来的执行器执行 */
  async commit(options: CommitOptions): Promise<CommitResult> {
    const { committer, tables, message, queryRunner } = options;
    const author = this.getAuthor(committer);
    await queryRunner.query(`CALL DOLT_ADD(${this.getSqlArrayParam(tables)});`);
    try {
      const res = await queryRunner.query(
        `CALL DOLT_COMMIT('-Am', '${message}', '--author', '${author}');`
      );
      this.logger.log(`commit "${message}" successfully => ${res[0]?.hash}`);
      return res[0];
    } catch (error) {
      if (error.message === 'nothing to commit') {
        return { error: error.message };
      }
      throw error;
    }
  }

  /** 提交：使用新的事务执行 */
  async commitNt(tree: string, options: CommitNtOptions) {
    const dataSource = await treeDataSources.getDataSource(tree);
    const queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const res = await this.commit({
        ...options,
        queryRunner,
      });

      await queryRunner.commitTransaction();
      return res;
    } catch (error) {
      this.logger.error('commit failed', error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 分支操作 (新建/重命名/删除)
   * https://docs.dolthub.com/sql-reference/version-control/dolt-sql-procedures#dolt_branch
   *
   */
  async DOLT_BRANCH(args: string[], queryRunner?: QueryRunner) {
    const sql = `CALL DOLT_BRANCH(${this.getSqlArrayParam(args)});`;
    this.logger.log(sql);
    if (queryRunner) {
      return queryRunner.query(sql);
    }
    const dataSource = await treeDataSources.getDataSource(TREE_DEFAULT);
    queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const res = await queryRunner.query(sql);

      await queryRunner.commitTransaction();
      return res;
    } catch (error) {
      this.logger.error('DOLT_BRANCH failed', error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 重置提交
   * https://docs.dolthub.com/sql-reference/version-control/dolt-sql-procedures#dolt_reset
   *
   */
  async DOLT_RESET(args: string[], queryRunner?: QueryRunner, tree?: string) {
    const sql = `CALL DOLT_RESET(${this.getSqlArrayParam(args)});`;
    this.logger.log(sql);
    if (queryRunner) {
      return queryRunner.query(sql);
    }
    const dataSource = await treeDataSources.getDataSource(tree || TREE_DEFAULT);
    queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const res = await queryRunner.query(sql);

      await queryRunner.commitTransaction();
      return res;
    } catch (error) {
      this.logger.error('DOLT_RESET failed', error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 合并分支
   * https://docs.dolthub.com/sql-reference/version-control/dolt-sql-procedures#dolt_merge
   *
   */
  async DOLT_MERGE(targetBranch: string, mergeArgs: string[], committer?: ILoginUser) {
    if (!mergeArgs.includes('--author')) {
      mergeArgs.push('--author', this.getAuthor(committer));
    }
    const dataSource = await treeDataSources.getDataSource(targetBranch);
    const queryRunner = dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const sql = `CALL DOLT_MERGE(${this.getSqlArrayParam(mergeArgs)});`;
      this.logger.log(sql);
      const res = await queryRunner.query(sql);

      await queryRunner.commitTransaction();
      return res;
    } catch (error) {
      this.logger.error('DOLT_MERGE failed', error);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 获取提交的 commits
   *
   */
  async DOLT_DIFF(targetBranch: string, sourceBranch: string) {
    const dataSource = await treeDataSources.getDataSource();
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();

    try {
      const sql = `SELECT * FROM DOLT_LOG("${targetBranch}..${sourceBranch}");`;
      const results = await queryRunner.query(sql);
      const comits = new Array<Commit>();
      for (const data of results) {
        const comitData = new Commit();
        comitData.hash = data.commit_hash;
        comitData.committer = data.committer;
        comitData.message = data.message;
        comitData.date = data.date;
        comitData.email = data.email;
        comits.push(comitData);
      }

      return comits;
    } finally {
      queryRunner.release();
    }
  }

  /**
   * 获取提交的 commits
   *
   */
  async getDiffBranchData(targetBranch: string, sourceBranch: string) {
    const dataSource = await treeDataSources.getDataSource();
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();

    const results = new DiffData();
    results.dataDiff = new Array<DataDiff>();
    results.schemaDiff = new Array<SchemaDiff>();

    try {
      let sql = `SELECT * FROM DOLT_SCHEMA_DIFF("${targetBranch}", "${sourceBranch}");`;
      const schemaDiffs = await queryRunner.query(sql);
      for (const schemaDiff of schemaDiffs) {
        const schemaData = new SchemaDiff();
        schemaData.tableName = schemaDiff.from_table_name;
        schemaData.our = {
          schema: schemaDiff.from_create_statement,
        };
        schemaData.their = {
          schema: schemaDiff.to_create_statement,
        };
        results.schemaDiff.push(schemaData);
      }
      sql = `SELECT * FROM DOLT_LOG("${targetBranch}..${sourceBranch}");`;
      const commits = await queryRunner.query(sql);
      const changedTableSet = new Set<string>();
      for (const commit of commits) {
        sql = `SELECT * FROM dolt_diff where commit_hash = "${commit.commit_hash}";`;
        const changes = await queryRunner.query(sql);
        for (const change of changes) {
          changedTableSet.add(change.table_name);
        }
      }
      for (const tableName of changedTableSet) {
        const dataDiff = new DataDiff();
        dataDiff.tableName = tableName;
        dataDiff.our = new Object();
        dataDiff.their = new Object();
        sql = `SELECT * FROM dolt_diff("${targetBranch}", "${sourceBranch}", "${tableName}");`;
        const dataDiffs = await queryRunner.query(sql);
        for (const diffData of dataDiffs) {
          const keys = Object.keys(diffData);
          for (const key of keys) {
            if (key.startsWith(FROM)) {
              const columnName = key.replace(FROM, '');
              const fromData = diffData[key];
              const toData = diffData[`${TO}${columnName}`];
              if (
                columnName !== COMMIT_COLUMN &&
                columnName !== COMMIT_DATE_COLUMN &&
                JSON.stringify(fromData) !== JSON.stringify(toData)
              ) {
                dataDiff.our[columnName] = fromData;
                dataDiff.their[columnName] = toData;
              }
            }
          }
        }
        results.dataDiff.push(dataDiff);
      }
      return results;
    } finally {
      queryRunner.release();
    }
  }
}
