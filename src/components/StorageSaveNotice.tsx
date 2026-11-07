import { useState, useSyncExternalStore } from "react";
import { getStorageWriteFailures, retryFailedStorageWrites, subscribeStorageWriteFailures } from "../app/sqliteStorage";
import "./storageSaveNotice.css";

export default function StorageSaveNotice() {
  const failures = useSyncExternalStore(subscribeStorageWriteFailures, getStorageWriteFailures, getStorageWriteFailures);
  const [retrying, setRetrying] = useState(false);
  if (!failures.length) return null;
  return (
    <aside className="storage-save-notice" aria-label="数据保存状态">
      <div role="alert">
        <strong>有 {failures.length} 项更改尚未保存到磁盘</strong>
        <p>请保持应用打开，检查磁盘空间或权限后重试保存。重试不会重新执行任务。</p>
        <details><summary>查看原因</summary>{failures.map((failure) => <p key={failure.key}>{failure.message}</p>)}</details>
      </div>
      <button type="button" disabled={retrying} onClick={async () => {
        setRetrying(true);
        try { await retryFailedStorageWrites(); } finally { setRetrying(false); }
      }}>{retrying ? "正在保存…" : "重试保存"}</button>
    </aside>
  );
}
