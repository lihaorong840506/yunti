import { Injectable, Logger } from '@nestjs/common';
import { isEqual } from 'lodash';
import { QueryRunner } from 'typeorm';

import { AppsMembersService } from '@/apps-members/apps-members.service';
import { MergeRequest } from '@/common/entities/git/merge-request.entity';
import { MemberRole } from '@/common/models/member-role.enum';
import { MergeRequestSourceType } from '@/common/models/merge-request-source-type.enum';
import { MergeRequestStatus } from '@/common/models/merge-request-status.enum';
import treeDataSources from '@/common/tree-data-sources';
import { CustomException, genNanoid } from '@/common/utils';
import { ComponentsMembersService } from '@/components-members/components-members.service';
import { GitService } from '@/git/git.service';
import { ILoginUser } from '@/types';

import { ConflictResolveInput } from './dto/conflict-resolve.input';
import { MergeRequestSearchInput } from './dto/merge-request-search.args';
import { MergeRequestInput } from './dto/merge-request.args';
import {
  ConflictDiffData,
  ConflictDiffSchema,
  MergeRequestDetail,
  MergeRequestDiff,
} from './models/merge-request-detail.model';

const BASE_PRE_FIX = 'base_';
const OUR_PRE_FIX = 'our_';
const THEIR_PRE_FIX = 'their_';
const PRIMARY_KEY = 'PRI';

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
export class MergeRequestService {
  constructor(
    private readonly gitService: GitService,
    private readonly appsMembersService: AppsMembersService,
    private readonly componentsMembersService: ComponentsMembersService
  ) {}

  logger = new Logger('PagesService');

  getMergeRequestRepository = () =>
    treeDataSources.getRepository<MergeRequest>(undefined, MergeRequest);

  /**
   * 创建合并请求
   */
  async createMergeRequest(
    user: ILoginUser,
    mergeRequestInput: MergeRequestInput
  ): Promise<MergeRequest> {
    const mergeRequestRepository = await this.getMergeRequestRepository();

    const registedMR = await mergeRequestRepository.findOne({
      where: {
        targetBranchName: mergeRequestInput.target_branch,
        sourceBranchName: mergeRequestInput.source_branch,
        mergeRequestStatus: MergeRequestStatus.Openning,
      },
    });
    if (registedMR) {
      throw new CustomException('ALREADY_REGISTED', 'Already registed', 409);
    }

    const diffCommits = await this.gitService.DOLT_DIFF(
      mergeRequestInput.target_branch,
      mergeRequestInput.source_branch
    );
    if (diffCommits.length === 0) {
      throw new CustomException('NO CHANGES', 'No changes', 404);
    }
    const typeId = mergeRequestInput.target_branch.split('/')[0];
    let type;
    type = typeId.startsWith('app') ? 'app' : 'component';

    const mergeRequestData = new MergeRequest();
    mergeRequestData.authorId = user.id;
    mergeRequestData.assigneeId = mergeRequestInput.assignee_id;
    mergeRequestData.sourceBranchName = mergeRequestInput.source_branch;
    mergeRequestData.targetBranchName = mergeRequestInput.target_branch;
    mergeRequestData.title = mergeRequestInput.title;
    mergeRequestData.description = mergeRequestInput.description;
    mergeRequestData.mergeRequestSourceType = type;
    mergeRequestData.mergeRequestSourceId = typeId;

    const dataSource = await treeDataSources.getDataSource(mergeRequestData.targetBranchName);
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    // 当提交代码时检查当前分支是否干净
    await this.checkMRBranchesAreClean(
      queryRunner,
      mergeRequestData.sourceBranchName,
      mergeRequestData.targetBranchName
    );

    await this.getConflictInfo(mergeRequestData, queryRunner);

    await queryRunner.rollbackTransaction();
    return await mergeRequestRepository.save(mergeRequestData);
  }

  /**
   * 获取合并请求
   */
  async getMergeRequests(
    user: ILoginUser,
    mergeRequestQueryParam: MergeRequestSearchInput
  ): Promise<Array<MergeRequest>> {
    let where;
    if (mergeRequestQueryParam.appId) {
      where = {
        mergeRequestSourceId: mergeRequestQueryParam.appId,
      };
    }
    if (mergeRequestQueryParam.componentId) {
      where = {
        mergeRequestSourceId: mergeRequestQueryParam.appId,
      };
    }

    if (mergeRequestQueryParam.status) {
      where.mergeRequestStatus = mergeRequestQueryParam.status;
    } else {
      where = [
        Object.assign({ mergeRequestStatus: MergeRequestStatus.Openning }, where),
        Object.assign({ mergeRequestStatus: MergeRequestStatus.Conflicted }, where),
        Object.assign({ mergeRequestStatus: MergeRequestStatus.Draft }, where),
      ];
    }

    const mergeRequestRepository = await this.getMergeRequestRepository();
    const result = await mergeRequestRepository.find({
      where,
      relations: {
        author: true,
        sourceBranch: true,
        targetBranch: true,
        assignee: true,
      },
      order: {
        updateAt: 'DESC',
      },
    });
    return result;
  }

  /**
   * 获取合并请求详细内容
   */
  async getMergeRequest(id: number): Promise<MergeRequestDetail> {
    if (Number.isNaN(id)) {
      throw new CustomException('ID IS WRONG', `id is wrong, not a number: ${id} `, 400);
    }
    const mergeRequestRepository = await this.getMergeRequestRepository();
    const mergeRequest = await mergeRequestRepository.findOne({
      where: {
        id,
      },
      relations: {
        author: true,
        sourceBranch: true,
        targetBranch: true,
        assignee: true,
      },
    });
    if (!mergeRequest) {
      throw new CustomException('NO MERGE REQUEST FOUND', `id is wrong, not a number: ${id} `, 400);
    }

    const mergeRequestDetail = new MergeRequestDetail();
    mergeRequestDetail.id = mergeRequest.id;
    mergeRequestDetail.assignee = mergeRequest.assignee;
    mergeRequestDetail.assigneeId = mergeRequest.assigneeId;
    mergeRequestDetail.author = mergeRequest.author;
    mergeRequestDetail.authorId = mergeRequest.authorId;
    mergeRequestDetail.mergeUserId = mergeRequest.mergeUserId;
    mergeRequestDetail.mergeUser = mergeRequest.mergeUser;
    mergeRequestDetail.title = mergeRequest.title;
    mergeRequestDetail.description = mergeRequest.description;
    mergeRequestDetail.mergeCommitSha = mergeRequest.mergeCommitSha;
    mergeRequestDetail.sourceBranch = mergeRequest.sourceBranch;
    mergeRequestDetail.sourceBranchName = mergeRequest.sourceBranchName;
    mergeRequestDetail.targetBranch = mergeRequest.targetBranch;
    mergeRequestDetail.targetBranchName = mergeRequest.targetBranchName;
    mergeRequestDetail.targetCommitSha = mergeRequest.targetCommitSha;
    mergeRequestDetail.mergeError = mergeRequest.mergeError;
    mergeRequestDetail.mergeRequestSourceType = mergeRequest.mergeRequestSourceType;
    mergeRequestDetail.mergeRequestSourceId = mergeRequest.mergeRequestSourceId;
    mergeRequestDetail.mergeRequestStatus = mergeRequest.mergeRequestStatus;
    mergeRequestDetail.conflictData = new Object();
    mergeRequestDetail.conflictData.dataConflicts = null;
    try {
      mergeRequestDetail.conflictData.dataConflicts =
        (mergeRequest.conflictDiffData && JSON.parse(mergeRequest.conflictDiffData.toString())) ||
        null;
    } catch (error) {
      this.logger.error(error);
    }
    const conflictDiffSchema =
      mergeRequest.conflictDiffSchema && mergeRequest.conflictDiffSchema.toString();
    try {
      mergeRequestDetail.conflictData.schemaConflicts =
        (mergeRequestDetail.mergeRequestStatus === MergeRequestStatus.Conflicted &&
          conflictDiffSchema &&
          mergeRequest.conflictDiffSchema &&
          JSON.parse(mergeRequest.conflictDiffSchema.toString())) ||
        null;
    } catch (error) {
      this.logger.error(error);
    }
    mergeRequestDetail.updaterId = mergeRequest.updaterId;
    mergeRequestDetail.updater = mergeRequest.updater;
    mergeRequestDetail.createAt = mergeRequest.createAt;
    mergeRequestDetail.updateAt = mergeRequest.updateAt;

    mergeRequestDetail.commits = await this.gitService.DOLT_DIFF(
      mergeRequest.targetBranchName,
      mergeRequest.sourceBranchName
    );

    mergeRequestDetail.diffData = await this.gitService.getDiffBranchData(
      mergeRequest.targetBranchName,
      mergeRequest.sourceBranchName
    );
    return mergeRequestDetail;
  }

  /**
   * 获取合并请求对比内容
   */
  async getBranchesDiff(targetBranch: string, sourceBranch: string): Promise<MergeRequestDiff> {
    const mergeRequestDiff = new MergeRequestDiff();
    if (!targetBranch || !sourceBranch || targetBranch === sourceBranch) {
      return mergeRequestDiff;
    }

    mergeRequestDiff.commits = await this.gitService.DOLT_DIFF(targetBranch, sourceBranch);

    mergeRequestDiff.diffData = await this.gitService.getDiffBranchData(targetBranch, sourceBranch);

    return mergeRequestDiff;
  }

  /**
   * 关闭合并请求
   */
  async closeMergeRequests(user: ILoginUser, id: number) {
    if (!id) {
      throw new CustomException('BadRequest', 'id is empty', 400);
    }

    const mergeRequestRepository = await this.getMergeRequestRepository();
    const mergeRequest = await mergeRequestRepository.findOne({
      where: { id },
    });

    if (!mergeRequest) {
      throw new CustomException('NOTHING_TO_CLOSE', 'nothing to commit, working tree clean', 400);
    }

    if (mergeRequest.mergeRequestStatus === MergeRequestStatus.Closed) {
      throw new CustomException('ALREADY_CLOSED', 'Already closed', 409);
    }

    // 当关闭检查用户权限是否足够
    if (mergeRequest.authorId !== user.id || mergeRequest.assigneeId !== user.id) {
      await this.checkMRPermission(user, mergeRequest);
    }

    mergeRequest.mergeRequestStatus = MergeRequestStatus.Closed;
    mergeRequest.updaterId = user.id;
    const result = await mergeRequestRepository.save(mergeRequest);
    return result;
  }

  /**
   * 解决冲突
   */
  async resolveConflict(user: ILoginUser, conflictResolveInput: ConflictResolveInput) {
    const mergeRequestRepository = await this.getMergeRequestRepository();

    if (Number.isNaN(conflictResolveInput.id)) {
      throw new CustomException('BadRequest', 'id is empty', 400);
    }

    const mergeRequest = await mergeRequestRepository.findOne({
      where: { id: conflictResolveInput.id },
    });

    if (!mergeRequest) {
      throw new CustomException('NOTHING_TO_MERGE', 'nothing to merge, working tree clean', 400);
    }

    const result = {
      result: 'ok',
    };

    if (mergeRequest.mergeRequestStatus !== MergeRequestStatus.Conflicted) {
      throw new CustomException('ALREADY_RESOLVED', 'Already resolved', 400);
    }

    // 提出者或者对对应分支有权限的才可以解决冲突
    if (mergeRequest.authorId !== user.id) {
      await this.checkMRPermission(user, mergeRequest);
    }

    // 当数据完全使用源代码数据时不需要对源代码进行 commit
    let isNeedCommit = false;
    const dataSource = await treeDataSources.getDataSource(mergeRequest.sourceBranchName);
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      if (mergeRequest.conflictDiffData) {
        let conflictDataArray;
        try {
          conflictDataArray = JSON.parse(mergeRequest.conflictDiffData);
        } catch {
          this.logger.error('parse error', mergeRequest.conflictDiffData);
          conflictDataArray = [];
        }

        if (mergeRequest.conflictDiffSchema) {
          let conflictSchemaArray;
          try {
            conflictSchemaArray = JSON.parse(mergeRequest.conflictDiffSchema);
          } catch {
            this.logger.error('parse error', mergeRequest.conflictDiffSchema);
            conflictSchemaArray = [];
          }
          for (const conflictSchema of conflictSchemaArray) {
            for (const inputResolveSchema of conflictResolveInput.conflictData['schemaConflicts']) {
              if (
                conflictSchema.tableName === inputResolveSchema.tableName &&
                !isEqual(conflictSchema.their.schema, inputResolveSchema.their['schema'])
              ) {
                // 当数据完全使用源代码数据时不需要对源代码进行 commit
                isNeedCommit = true;
                // 更新 ddl
                const sql = inputResolveSchema.their['schema'];
                await queryRunner.query(sql);
                conflictSchema.their.schema = inputResolveSchema.their['schema'];
              }
            }
          }

          mergeRequest.conflictDiffSchema = JSON.stringify(conflictSchemaArray);
        }

        for (const conflictData of conflictDataArray) {
          for (const inputResolveData of conflictResolveInput.conflictData.dataConflicts) {
            // 确保冲突修改部分一一匹配
            // 确保冲突修改部分一一匹配
            // 当数据完全使用源代码数据时不需要对源代码进行 commit
            if (
              inputResolveData.tableName === conflictData.tableName &&
              !isEqual(conflictData.their, inputResolveData.their)
            ) {
              isNeedCommit = true;
              let sql = `DESC ${conflictData.tableName};`;
              const tableResults = await queryRunner.query(sql);
              const tPKs = [];
              for (const column of tableResults) {
                if (column.Key === PRIMARY_KEY) {
                  tPKs.push(column.Field);
                }
              }
              // 更新 表数据为解决冲突的数据，最终提交 SQL
              sql = `UPDATE ${conflictData.tableName} SET `;
              const params = [];
              for (const k of Object.keys(inputResolveData.their)) {
                const v = inputResolveData.their[k];
                if (v === null) {
                  sql += ` \`${k}\` = null, `;
                } else if (typeof v === 'object') {
                  sql += ` \`${k}\` = ?, `;
                  params.push(JSON.stringify(v));
                } else if (!tPKs.includes(k)) {
                  sql += ` \`${k}\` = ?, `;
                  params.push(v);
                }
              }
              // 条件
              sql = sql.replace(/, $/, ' ');
              sql += ` WHERE `;
              for (let pk of tPKs) {
                sql += `\`${pk}\` = ? AND`;
                params.push(conflictData.their[pk]);
              }

              sql = sql.replace(/ AND/, ';');
              await queryRunner.query(sql, params);
              conflictData.their = inputResolveData.their;
            }
          }
        }
        mergeRequest.conflictDiffData = JSON.stringify(conflictDataArray);
      }

      mergeRequest.mergeRequestStatus = MergeRequestStatus.Openning;
      mergeRequest.updaterId = user.id;

      await mergeRequestRepository.save(mergeRequest);
      // 当数据完全使用源代码数据时不需要对源代码进行 commit
      if (isNeedCommit) {
        let sql = `CALL DOLT_COMMIT('-Am', 'Merge branch ${mergeRequest.sourceBranchName} for resolve conflict');`;
        await queryRunner.query(sql);
        await queryRunner.commitTransaction();
      }
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return result;
  }

  /**
   * 合并
   */
  async mergeRequest(user: ILoginUser, id: number) {
    const mergeRequestRepository = await this.getMergeRequestRepository();

    if (Number.isNaN(id)) {
      throw new CustomException('BadRequest', 'id is empty', 400);
    }

    const mergeRequest = await mergeRequestRepository.findOne({
      where: { id },
    });

    if (!mergeRequest) {
      throw new CustomException('NOTHING_TO_MERGE', 'nothing to merge, working tree clean', 400);
    }

    const result = {
      result: 'ok',
    };

    if (mergeRequest.mergeRequestStatus !== MergeRequestStatus.Openning) {
      throw new CustomException('IS_NOT_OPENNING', 'merge request is not openning status', 400);
    }

    // 查看合并权限是否满足 Owner 或 maintainer, 或当前分支的 owner
    await this.checkMRPermission(user, mergeRequest);

    const dataSource = await treeDataSources.getDataSource(mergeRequest.targetBranchName);
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // 当提交代码时检查当前分支是否干净
      await this.checkMRBranchesAreClean(
        queryRunner,
        mergeRequest.sourceBranchName,
        mergeRequest.targetBranchName
      );

      let sql = `set @@dolt_allow_commit_conflicts = 1;`;
      await queryRunner.query(sql);
      sql = `CALL DOLT_CHECKOUT('${mergeRequest.targetBranchName}');`;
      await queryRunner.query(sql);
      sql = `CALL DOLT_MERGE('${mergeRequest.sourceBranchName}');`;
      const mergeResult = await queryRunner.query(sql);
      let conflictData, conflictSchema;
      const tableSet = new Set();
      // 有冲突时根据冲突解决方案解决冲突
      if (Array.isArray(mergeResult) && mergeResult.length > 0 && mergeResult[0].conflicts > 0) {
        try {
          conflictData =
            (mergeRequest.conflictDiffData && JSON.parse(mergeRequest.conflictDiffData)) || null;
        } catch (error) {
          this.logger.error('conflictDiffData parse error:', error);
        }
        if (conflictData) {
          for (const finalData of conflictData) {
            const params = new Array();
            sql = `UPDATE dolt_conflicts_${finalData.tableName} SET `;
            for (const key of Object.keys(finalData.their)) {
              sql += `${THEIR_PRE_FIX}${key} = ?,`;
              let param = finalData.their[key];
              if (typeof param === 'object') {
                param = JSON.stringify(param);
              }
              params.push(param);
            }
            sql = `${sql.replace(/,$/, '')} WHERE 1 = 1;`;
            await queryRunner.query(sql, params);
            tableSet.add(finalData.tableName);
          }
        }
        try {
          conflictSchema =
            (mergeRequest.conflictDiffSchema && JSON.parse(mergeRequest.conflictDiffSchema)) ||
            null;
        } catch (error) {
          this.logger.error('conflictDiffSchema parse error:', error);
        }
        if (conflictSchema) {
          for (const finalSchema of conflictSchema) {
            const params = new Array();
            sql = `UPDATE dolt_schema_conflicts SET `;
            sql += ` their_schema = ? WHERE table_name = ?;`;
            params.push(finalSchema.their['schema'], finalSchema.tableName);
            await queryRunner.query(sql, params);
            tableSet.add(finalSchema.tableName);
          }
        }

        // 对于已经解决好的冲突，根据冲突解决方案根据 --our 进行冲突解决
        // https://docs.dolthub.com/sql-reference/version-control/merges#schema
        if (tableSet.size > 0) {
          sql = `CALL DOLT_CONFLICTS_RESOLVE('--theirs'`;
          for (const key of tableSet.keys()) {
            sql += `, '${key}'`;
          }
          sql += ');';
          await queryRunner.query(sql);
          sql = `CALL DOLT_COMMIT('-Am', 'Merge branch ${mergeRequest.sourceBranchName} for resolve conflict');`;
          await queryRunner.query(sql);
          mergeRequest.mergeRequestStatus = MergeRequestStatus.Merged;
        } else {
          await this.getConflictInfo(mergeRequest, queryRunner);
        }
      } else {
        mergeRequest.mergeRequestStatus = MergeRequestStatus.Merged;
        mergeRequest.mergeUserId = user.id;
      }

      await mergeRequestRepository.save(mergeRequest);
      await (mergeRequest.mergeRequestStatus.valueOf() === MergeRequestStatus.Conflicted.valueOf()
        ? queryRunner.rollbackTransaction()
        : queryRunner.commitTransaction());
    } catch (error) {
      this.logger.error(error);
      await queryRunner.rollbackTransaction();
      if (error.sqlMessage && error.sqlMessage.includes('Merge conflict detected')) {
        result.result = 'Merge conflict detected';
        this.logger.error('resolve conflict failed', error);
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
    return result;
  }

  /**
   * 查看有哪些冲突，保存到合并数据中
   */
  async getConflictInfo(mergeRequest: MergeRequest, queryRunner: QueryRunner) {
    let sql = `CALL DOLT_CHECKOUT('${mergeRequest.targetBranchName}');`;
    await queryRunner.query(sql);
    const tmpBranchName = `${mergeRequest.targetBranchName}-${genNanoid('FOR-MERGE-CONFLICT')}`;
    sql = `CALL DOLT_BRANCH('${tmpBranchName}');`;
    await queryRunner.query(sql);
    // 设置合并允许合并
    sql = `set @@dolt_allow_commit_conflicts = 1;`;
    await queryRunner.query(sql);
    // 切换到临时分支
    sql = `CALL DOLT_CHECKOUT('${tmpBranchName}');`;
    await queryRunner.query(sql);
    sql = `CALL DOLT_MERGE('${mergeRequest.sourceBranchName}');`;
    await queryRunner.query(sql);

    // 冲突数据保存到 MR 表的 conflict_diff_data, conflict_diff_schema 数据中
    // sql = `SELECT table, num_conflicts FROM dolt_conflicts;`;
    sql = `SELECT * FROM dolt_conflicts;`;
    const conflictsTables = await queryRunner.query(sql);
    const confilctDataList = new Array<ConflictDiffData>();
    const confilctSchemaList = new Array<ConflictDiffSchema>();
    // 获取冲突数据
    for (const conflictTable of conflictsTables) {
      sql = `SELECT * FROM dolt_conflicts_${conflictTable.table};`;
      const conflictDataResults = await queryRunner.query(sql);
      const conflictInfo = new ConflictDiffData();
      conflictInfo.tableName = conflictTable.table;
      conflictInfo.our = new Object();
      conflictInfo.their = new Object();
      for (const conflictResult of conflictDataResults) {
        const columns = Object.keys(conflictResult);
        for (const columnName of columns) {
          if (columnName.startsWith(BASE_PRE_FIX)) {
            const originColumn = columnName.replace(BASE_PRE_FIX, '');
            const theirColumn = columnName.replace(BASE_PRE_FIX, THEIR_PRE_FIX);
            const ourColumn = columnName.replace(BASE_PRE_FIX, OUR_PRE_FIX);
            conflictInfo.our[originColumn] = conflictResult[ourColumn];
            conflictInfo.their[originColumn] = conflictResult[theirColumn];
          }
        }
      }
      if (Object.keys(conflictInfo.our).length > 0) {
        confilctDataList.push(conflictInfo);
      }
    }
    if (confilctDataList.length > 0) {
      mergeRequest.conflictDiffData = JSON.stringify(confilctDataList);
    }

    sql = `SELECT * FROM dolt_schema_conflicts;`;
    const conflictsSchema = await queryRunner.query(sql);
    for (const schema of conflictsSchema) {
      const conflictSchemaObj = new ConflictDiffSchema();
      conflictSchemaObj.tableName = schema.table_name;
      conflictSchemaObj.our = schema.our_schema;
      conflictSchemaObj.their = schema.their_schema;
      confilctSchemaList.push(conflictSchemaObj);
    }

    if (confilctSchemaList.length > 0) {
      mergeRequest.conflictDiffSchema = JSON.stringify(confilctSchemaList);
    }

    if (confilctDataList.length > 0 || confilctSchemaList.length > 0) {
      mergeRequest.mergeRequestStatus = MergeRequestStatus.Conflicted;
    } else {
      mergeRequest.mergeRequestStatus = MergeRequestStatus.Openning;
      mergeRequest.conflictDiffSchema = '';
      mergeRequest.conflictDiffData = '';
    }

    sql = `CALL DOLT_CHECKOUT('${mergeRequest.targetBranchName}');`;
    await queryRunner.query(sql);

    sql = `CALL DOLT_BRANCH('-D', '${tmpBranchName}');`;
    await queryRunner.query(sql);
  }

  async checkMRBranchesAreClean(
    queryRunner: QueryRunner,
    sourceBranchName: string,
    targetBranchName: string
  ) {
    let sql = `CALL DOLT_CHECKOUT('${sourceBranchName}');`;
    await queryRunner.query(sql);
    sql = 'SELECT * FROM dolt_status;';
    const sourceBranchStatusResults = await queryRunner.query(sql);
    if (sourceBranchStatusResults.length > 0) {
      throw new CustomException(
        'BadRequest',
        `Branch ${sourceBranchName} is not clean, commit changes first please.`,
        404
      );
    }
    sql = `CALL DOLT_CHECKOUT('${targetBranchName}');`;
    await queryRunner.query(sql);
    sql = 'SELECT * FROM dolt_status;';
    const targetBranchStatusResults = await queryRunner.query(sql);
    if (targetBranchStatusResults.length > 0) {
      throw new CustomException(
        'BadRequest',
        `Branch ${targetBranchName} is not clean, commit changes first please.`,
        404
      );
    }
  }

  async checkMRPermission(user: ILoginUser, mergeRequest: MergeRequest) {
    const targetBranchInfo = mergeRequest.targetBranchName.split('/');
    if (targetBranchInfo && targetBranchInfo.length < 2) {
      throw new CustomException(
        'TARGET BRANCH NAME IS WRONG',
        `Full target branche name is wrong: ${mergeRequest.targetBranchName}`,
        400
      );
    }
    // 当前分支为用户分支时可以修改，非用户分支时看是否为 owner 或者 maintainer
    if (targetBranchInfo[1] !== user.id) {
      let memberRole;
      memberRole = await (mergeRequest.mergeRequestSourceType === MergeRequestSourceType.app
        ? this.appsMembersService.checkUserAppMemberRole(user, mergeRequest.mergeRequestSourceId)
        : this.componentsMembersService.checkUserComponentMemberRole(
            user,
            mergeRequest.mergeRequestSourceId
          ));
      if (memberRole !== MemberRole.Owner && memberRole !== MemberRole.Maintainer) {
        throw new CustomException(
          'Forbidden',
          'Only MR creator, Branch owner, App onwer and App maintainer can operate the MR',
          403
        );
      }
    }
  }

  async refreshMergeRequest(user: ILoginUser, sourceBranchName: string) {
    const mergeRequestRepository = await this.getMergeRequestRepository();
    const mergeRequests = await mergeRequestRepository.find({
      where: [
        { sourceBranchName, mergeRequestStatus: MergeRequestStatus.Openning },
        { sourceBranchName, mergeRequestStatus: MergeRequestStatus.Conflicted },
        { targetBranchName: sourceBranchName, mergeRequestStatus: MergeRequestStatus.Openning },
        { targetBranchName: sourceBranchName, mergeRequestStatus: MergeRequestStatus.Conflicted },
      ],
    });
    for (const mergeRequest of mergeRequests) {
      const dataSource = await treeDataSources.getDataSource(mergeRequest.targetBranchName);
      const queryRunner = dataSource.createQueryRunner();
      try {
        await queryRunner.connect();
        await queryRunner.startTransaction();
        await this.getConflictInfo(mergeRequest, queryRunner);
        await queryRunner.rollbackTransaction();
        mergeRequest.updaterId = user.id;
        await mergeRequestRepository.save(mergeRequest);
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
    }
  }
}
