"""Built Astra assets and fail-closed auth; no socket or external market call."""
import re
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from astra.app import create_app
from astra.config import Settings
from astra.service import TradingService

class OfflineProvider:
    async def snapshot(self, symbols):
        raise AssertionError('Preview check must not call a market provider')
    async def close(self):
        pass

def test_built_preview_assets_and_unconfigured_auth(tmp_path):
    if not (Path(__file__).resolve().parents[1] / 'frontend/dist/index.html').is_file():
        pytest.skip('Build frontend first to verify its actual artifacts')
    settings = Settings(database_path=str(tmp_path / 'preview.sqlite3'), password='', jwt_secret='',
        background_jobs=False, openai_api_key='', max_ai_daily=0, max_ai_run=0,
        shadow_trading=False, universe=('SPY',), risk_limits={})
    service = TradingService(settings, provider=OfflineProvider())
    with TestClient(create_app(settings, service), base_url='https://preview.example') as client:
        assert client.get('/healthz').status_code == 200
        for route in ['/astra', '/astra/']:
            page = client.get(route)
            assert page.status_code == 200
            assets = re.findall(r'(?:src|href)="(/astra/assets/[^\"]+)"', page.text)
            assert len(assets) >= 2
            for asset in assets:
                response = client.get(asset)
                assert response.status_code == 200
                if asset.endswith('.js'):
                    assert '無料プレビュー用コピー' in response.text
                    assert '完全復元用バックアップではありません' in response.text
        assert client.get('/api/astra/dashboard').status_code == 401
        assert client.post('/api/astra/auth/login', json={'password':'dummy-preview-password'}).status_code == 503
        assert not service.settings.openai_api_key
        assert not service.settings.shadow_trading
