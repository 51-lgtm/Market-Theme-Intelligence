import React, { useEffect, useState } from "react";
import { createTreasuryYieldStore, treasuryYieldView, TREASURY_SOURCE_URL, TREASURY_METHOD_NOTE } from "./treasuryYield.js";

const treasuryStore = createTreasuryYieldStore();

export default function TreasuryYieldPanel() {
  const [state, setState] = useState(treasuryStore.getState);
  useEffect(() => {
    const unsubscribe = treasuryStore.subscribe(setState);
    // Resubscription also catches a request completed while this view was hidden.
    setState(treasuryStore.getState());
    treasuryStore.load();
    return unsubscribe;
  }, []);
  const view = treasuryYieldView(state.payload, { requestFailed: state.requestFailed });
  return <section className={`treasury-panel ${view.status}`} aria-labelledby="treasury-yield-title" aria-busy={state.loading}>
    <div className="treasury-head">
      <div><span className="treasury-kicker">OFFICIAL DAILY DATA</span><h2 id="treasury-yield-title">米国10年国債利回り <small>米財務省公式</small></h2></div>
      <button className="treasury-refresh" type="button" onClick={() => treasuryStore.load(true)} disabled={state.loading}>{state.loading ? "取得中…" : "公式値を再取得"}</button>
    </div>
    <div className="treasury-status" role="status">{state.loading ? "公式日次データを取得中…" : view.statusLabel}</div>
    <dl className="treasury-values">
      <div><dt>10年・パー利回り</dt><dd className="treasury-yield">{view.yieldText}</dd></div>
      <div><dt>公表データ日 (as of)</dt><dd>{view.asOf || "N/A"}</dd></div>
      <div><dt>前回公表データ日</dt><dd>{view.previousDate || "N/A"}</dd><small>前回値 {view.previousText}</small></div>
      <div><dt>前回公表値との差</dt><dd>{view.changeText}</dd><small>株価の上昇・下落予測ではありません</small></div>
    </dl>
    <div className="treasury-meta"><span>公式データ取得 {view.retrievedText}</span><span>API確認 {view.checkedText}</span></div>
    <ul className="treasury-notes">{view.notes.map(note => <li key={note}>{note}</li>)}</ul>
    <p className="treasury-method">{TREASURY_METHOD_NOTE}</p>
    <a className="treasury-source" href={TREASURY_SOURCE_URL} target="_blank" rel="noopener noreferrer">出典：U.S. Department of the Treasury ↗</a>
  </section>;
}
