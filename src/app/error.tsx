'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="empty-state">
      <h1>暫時無法顯示頁面</h1>
      <p>請重新載入；如需確認航班，請前往出發機場或航空公司官方網站。</p>
      <button onClick={reset}>重新載入</button>
      <p>
        <a href="https://web.taoyuan-airport.com/index.aspx">機場官方查詢 ↗</a>
      </p>
    </main>
  );
}
