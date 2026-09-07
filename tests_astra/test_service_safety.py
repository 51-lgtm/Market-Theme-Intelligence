import asyncio
from copy import deepcopy
from astra.brokers import journal_snapshot
from astra.service import TradingService, completed_weekly, evidence_fingerprint
from astra.config import Settings
from tests_astra.test_api import Provider, system, login
from tests_astra.test_quant_core import decision, quote, NOW
import pytest


def test_complete_week_respects_observed_us_holiday():
    bars = [{"date": f"2026-06-{day}", "open": 100., "high": 103., "low": 98., "close": 101., "volume": 1000.} for day in (29, 30)]
    bars += [{"date": f"2026-07-0{day}", "open": 100., "high": 104., "low": 98., "close": 102., "volume": 1000.} for day in (1, 2)]
    assert completed_weekly(bars)[0]["volume"] == 4000
    assert completed_weekly(bars[:-1]) == []


def test_config_disallows_loopback_prefix_ssrf_and_invalid_universe():
    for url in ('http://127.0.0.1:80@evil.example','http://localhost:80/path','https://127.0.0.1:80','http://evil.example:80'):
        with pytest.raises(ValueError):
            Settings(legacy_url=url).validate()
    with pytest.raises(ValueError):
        Settings(universe=('SPY','../private')).validate()


def test_entry_snapshot_whitelists_features_and_handles_malformed_news():
    result = journal_snapshot({"ticker":"JMIA", "rsi14":45., "secret":"do-not-save", "analysis_snapshot":{
        "astra_score":80., "technical":{"daily":{"atr14":2.}}, "news":[None,"bad",{"headline":"filing","secret":"x"}]}})
    assert result["atr"] == 2 and result["astra_score"] == 80
    assert "secret" not in str(result) and len(result["news"]) == 1


def test_analysis_same_timestamp_changed_material_is_invalidated(tmp_path):
    service = TradingService(Settings(database_path=str(tmp_path/'db.sqlite3'), background_jobs=False, openai_api_key='', risk_limits={}), provider=Provider())
    row = {"ticker":"JMIA","as_of":"2026-09-04T20:00:00Z","data_status":"partial","agent_outputs":{"market":{"score":50.}}}
    service.rows = [row]
    class ChangingCommander:
        async def analyze(self, evidence, **kwargs):
            service.rows = [{**deepcopy(row),"agent_outputs":{"market":{"score":5.}}}]
            return {"decision":decision()}
    old = service.commander
    service.commander = ChangingCommander()
    result = asyncio.run(service.analyze('JMIA'))
    assert result["status"] == "stale"
    assert service.db.list_records('ai_decisions') == []
    asyncio.run(old.close())
    asyncio.run(service.close())


def test_fingerprint_ignores_presentational_commander_but_includes_news():
    row = {"ticker":"MU","agent_outputs":{"catalyst":{"items":[]}}}
    original = evidence_fingerprint(row)
    assert evidence_fingerprint({**row,"commander":{"some":"ui"}}) == original
    row['agent_outputs']['catalyst']['items'] = [{'headline':'new filing'}]
    assert evidence_fingerprint(row) != original


def test_order_api_replay_never_needs_new_quote(system):
    client, service = system
    headers = login(client)
    d = decision()
    service.db.save_record('ai_decisions','stored-id',{'ticker':d['ticker'],'decision':d})
    first = service.broker.submit(d, quote(), 'replay-safe-123', decision_id='stored-id', now=NOW)
    assert first['status'] == 'PENDING'
    response = client.post('/api/astra/shadow',json={'decision_id':'stored-id','idempotency_key':'replay-safe-123'},headers=headers)
    assert response.status_code == 200 and response.json()['idempotent_replay'] is True
    assert len(service.broker.orders()) == 1


def test_portfolio_import_invalidates_current_analysis(system):
    client, service = system
    headers = login(client)
    service.rows=[{'ticker':'MU','action':'BUY','data_status':'ok','risk_flags':[]}]
    response=client.post('/api/astra/portfolio/import',json={'positions':[{'ticker':'MU','shares':1.,'average_cost':10.}]},headers=headers)
    assert response.status_code == 200
    assert service.rows[0]['action'] == 'HOLD'
    assert 'portfolio_changed_requires_refresh' in service.rows[0]['risk_flags']


def test_exit_is_not_blocked_by_entry_only_liquidity_fields(system):
    _, service = system
    from datetime import timedelta
    service.broker.submit(decision(),quote(),'entry-liquidity-test',now=NOW)
    later=NOW+timedelta(seconds=2)
    service.broker.observe(quote(now=later),later)
    trade=service.broker.trades()[0]
    final=later+timedelta(seconds=2)
    q=quote(now=final)
    q.pop('average_volume'); q.pop('volume')
    closed=service.broker.close(trade['id'],q,'exit-liquidity-test',now=final)
    assert closed['status']=='CLOSED'


def test_out_of_order_quote_cannot_retroactively_close(system):
    _, service = system
    from datetime import timedelta
    service.broker.submit(decision(),quote(),'entry-ordering-123',now=NOW)
    service.broker.observe(quote(now=NOW+timedelta(seconds=2)),NOW+timedelta(seconds=2))
    service.broker.observe(quote(now=NOW+timedelta(seconds=5)),NOW+timedelta(seconds=5))
    trade=service.broker.trades()[0]
    result=service.broker.close(trade['id'],quote(now=NOW+timedelta(seconds=3)),'exit-ordering-123',now=NOW+timedelta(seconds=6))
    assert 'out_of_order_exit_quote' in result['reasons']
    assert service.broker.positions()


def test_commander_sell_closes_shadow_only_and_replay_is_safe(system, monkeypatch):
    _, service = system
    from datetime import timedelta
    service.broker.submit(decision(),quote(),'entry-commander-sell',now=NOW)
    service.broker.observe(quote(now=NOW+timedelta(seconds=2)),NOW+timedelta(seconds=2))
    final=NOW+timedelta(seconds=10)
    d={**decision(),'action':'SELL','position_size':0}
    row={'ticker':d['ticker'],'as_of':final.isoformat(),'data_status':'ok'}
    service.rows=[row]
    service.db.save_record('ai_decisions','sell-decision',{'ticker':d['ticker'],'decision':d,'evidence_as_of':row['as_of'],'source_fingerprint':evidence_fingerprint(row)})
    monkeypatch.setattr(service,'quote_for',lambda ticker:quote(now=final))
    monkeypatch.setattr(service.broker,'_now',lambda now=None:now or final)
    result=service.submit_shadow('sell-decision','sell-replay-123')
    assert result['status']=='CLOSED' and result['exit_decision_id']=='sell-decision'
    assert result['exit_reason']=='commander_sell' and service.broker.positions()==[]
    assert service.submit_shadow('sell-decision','sell-replay-123')['idempotent_replay']
    conflict=service.broker.close(result['id'],{},'sell-replay-123',decision_id='different-decision')
    assert conflict['reasons']==['idempotency_conflict']
