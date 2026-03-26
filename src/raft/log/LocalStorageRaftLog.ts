import { StorageRaftLog } from './StorageRaftLog';

/**
 * localStorage-backed Raft log implementation.
 * Survives page refreshes — suitable for durable sessions where peers
 * may rejoin after a restart.
 */
export class LocalStorageRaftLog<T = unknown> extends StorageRaftLog<T> {
  constructor(namespace: string) {
    super(localStorage, namespace);
  }
}
