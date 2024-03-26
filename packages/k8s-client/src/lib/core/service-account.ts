/**
 * 由 src/kubernetes/gen/index.ts 自动生成
 * !!! 请不要修改 !!!
 */

import * as K8s from '@kubernetes/client-node';
import {
  CreateOptions,
  PatchOptions,
  JsonPatchOp,
  DeleteOptions,
  DeleteCollectionSelectors,
  DeleteCollectionOptions,
  ReadOptions,
  ListOptions,
} from '../interfaces';
import {
  JSON_PATCH_CONTENT_TYPE,
  MERGE_PATCH_CONTENT_TYPE,
  STRATEGIC_MERGE_PATCH_CONTENT_TYPE,
} from '../utils/constants';
import { TimeExec } from '../decorators/time-exec.decorator';

/**
 * @category core
 */
@TimeExec()
export class ServiceAccount {
  constructor(private readonly k8sApi: K8s.CoreV1Api) {}

  kind = 'ServiceAccount';
  name = 'serviceaccounts';
  namespaced = true;
  version = 'v1';

  /**
   * 创建 ServiceAccount
   *
   * @param {string} namespace 命名空间
   * @param {K8s.V1ServiceAccount} body ServiceAccount 对象
   * @param {CreateOptions} [options] 可选配置项
   */
  create(
    namespace: string,
    body: K8s.V1ServiceAccount,
    options?: CreateOptions,
  ) {
    const { pretty, dryRun, fieldManager, fieldValidation, headers } =
      options || {};
    return this.k8sApi.createNamespacedServiceAccount(
      namespace,
      body,
      pretty,
      dryRun,
      fieldManager,
      fieldValidation,
      { headers },
    );
  }

  /**
   * 替换指定的 ServiceAccount
   *
   * @param {string} name ServiceAccount 名称
   * @param {string} namespace 命名空间
   * @param {K8s.V1ServiceAccount} body ServiceAccount 对象
   * @param {CreateOptions} [options] 可选配置项
   */
  replace(
    name: string,
    namespace: string,
    body: K8s.V1ServiceAccount,
    options?: CreateOptions,
  ) {
    const { pretty, dryRun, fieldManager, fieldValidation, headers } =
      options || {};
    return this.k8sApi.replaceNamespacedServiceAccount(
      name,
      namespace,
      body,
      pretty,
      dryRun,
      fieldManager,
      fieldValidation,
      { headers },
    );
  }

  /**
   * 部分更新指定的 ServiceAccount (JSON Patch)
   *
   * @param {string} name ServiceAccount 名称
   * @param {string} namespace 命名空间
   * @param {JsonPatchOp[]} body ServiceAccount 对象
   * @param {PatchOptions} [options] 可选配置项
   */
  patch(
    name: string,
    namespace: string,
    body: JsonPatchOp[],
    options?: PatchOptions,
  ) {
    const { pretty, dryRun, fieldManager, fieldValidation, force, headers } =
      options || {};
    return this.k8sApi.patchNamespacedServiceAccount(
      name,
      namespace,
      body,
      pretty,
      dryRun,
      fieldManager,
      fieldValidation,
      force,
      {
        headers: Object.assign({}, headers, {
          'Content-Type': JSON_PATCH_CONTENT_TYPE,
        }),
      },
    );
  }

  /**
   * 部分更新指定的 ServiceAccount (Merge Patch)
   *
   * @param {string} name ServiceAccount 名称
   * @param {string} namespace 命名空间
   * @param {object} body ServiceAccount 对象
   * @param {PatchOptions} [options] 可选配置项
   */
  patchMerge(
    name: string,
    namespace: string,
    body: object,
    options?: PatchOptions,
  ) {
    const { pretty, dryRun, fieldManager, fieldValidation, force, headers } =
      options || {};
    return this.k8sApi.patchNamespacedServiceAccount(
      name,
      namespace,
      body,
      pretty,
      dryRun,
      fieldManager,
      fieldValidation,
      force,
      {
        headers: Object.assign({}, headers, {
          'Content-Type': MERGE_PATCH_CONTENT_TYPE,
        }),
      },
    );
  }

  /**
   * 部分更新指定的 ServiceAccount (Strategic Merge Patch)
   *
   * @param {string} name ServiceAccount 名称
   * @param {string} namespace 命名空间
   * @param {object} body ServiceAccount 对象
   * @param {PatchOptions} [options] 可选配置项
   */
  patchStrategicMerge(
    name: string,
    namespace: string,
    body: object,
    options?: PatchOptions,
  ) {
    const { pretty, dryRun, fieldManager, fieldValidation, force, headers } =
      options || {};
    return this.k8sApi.patchNamespacedServiceAccount(
      name,
      namespace,
      body,
      pretty,
      dryRun,
      fieldManager,
      fieldValidation,
      force,
      {
        headers: Object.assign({}, headers, {
          'Content-Type': STRATEGIC_MERGE_PATCH_CONTENT_TYPE,
        }),
      },
    );
  }

  /**
   * 根据名称删除一个 ServiceAccount
   *
   * @param {string} name ServiceAccount 名称
   * @param {string} namespace 命名空间
   * @param {DeleteOptions} [options] 可选配置项
   */
  delete(name: string, namespace: string, options?: DeleteOptions) {
    const {
      pretty,
      dryRun,
      gracePeriodSeconds,
      orphanDependents,
      propagationPolicy,
      body,
      headers,
    } = options || {};
    return this.k8sApi.deleteNamespacedServiceAccount(
      name,
      namespace,
      pretty,
      dryRun,
      gracePeriodSeconds,
      orphanDependents,
      propagationPolicy,
      body,
      { headers },
    );
  }

  // <remove is="Service">
  /**
   * 根据选择器删除多个 ServiceAccount
   *
   * @param {string} namespace 命名空间
   * @param {DeleteCollectionSelectors} [selectors] 选择器
   * @param {DeleteCollectionOptions} [options] 可选配置项
   */
  deleteCollection(
    namespace: string,
    selectors?: DeleteCollectionSelectors,
    options?: DeleteCollectionOptions,
  ) {
    const { fieldSelector, labelSelector } = selectors;
    const {
      pretty,
      _continue,
      dryRun,
      gracePeriodSeconds,
      limit,
      orphanDependents,
      propagationPolicy,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      body,
      headers,
    } = options || {};
    return this.k8sApi.deleteCollectionNamespacedServiceAccount(
      namespace,
      pretty,
      _continue,
      dryRun,
      fieldSelector,
      gracePeriodSeconds,
      labelSelector,
      limit,
      orphanDependents,
      propagationPolicy,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      body,
      { headers },
    );
  }
  // </remove is="Service">

  /**
   * 根据名称获取 ServiceAccount 详情 (指定 namespace 下)
   *
   * @param {string} namespace 命名空间
   * @param {ListOptions} [options] 可选配置项
   */
  read(name: string, namespace: string, options?: ReadOptions) {
    const { pretty, headers } = options || {};
    return this.k8sApi.readNamespacedServiceAccount(name, namespace, pretty, {
      headers,
    });
  }

  /**
   * 列取 ServiceAccount 列表
   *
   * @param {string} namespace 命名空间
   * @param {ListOptions} [options] 可选配置项
   */
  list(namespace: string, options?: ListOptions) {
    const {
      pretty,
      allowWatchBookmarks,
      _continue,
      fieldSelector,
      labelSelector,
      limit,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      watch,
      headers,
    } = options || {};
    return this.k8sApi.listNamespacedServiceAccount(
      namespace,
      pretty,
      allowWatchBookmarks,
      _continue,
      fieldSelector,
      labelSelector,
      limit,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      watch,
      { headers },
    );
  }

  /**
   * 列取 ServiceAccount 列表 (所有 namespace 下)
   *
   * @param {ListOptions} [options] 可选配置项
   */
  listAll(options?: ListOptions) {
    const {
      allowWatchBookmarks,
      _continue,
      fieldSelector,
      labelSelector,
      limit,
      pretty,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      watch,
      headers,
    } = options || {};
    return this.k8sApi.listServiceAccountForAllNamespaces(
      allowWatchBookmarks,
      _continue,
      fieldSelector,
      labelSelector,
      limit,
      pretty,
      resourceVersion,
      resourceVersionMatch,
      sendInitialEvents,
      timeoutSeconds,
      watch,
      { headers },
    );
  }
}
