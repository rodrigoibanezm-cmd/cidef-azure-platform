import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from starlette.testclient import TestClient
from monthly_close_agent.entra_auth import EntraVerifier
from monthly_close_agent.mcp_server import create_app, commercial_analyze


class EntraTests(unittest.IsolatedAsyncioTestCase):
    async def test_claim_validation(self):
        v = EntraVerifier("tenant", "client", {"user"}, "probe")
        self.assertEqual((await v.verify_token("probe")).client_id, "p4-deployment-probe")
        claims = {"tid":"tenant","oid":"user","scp":"access_as_user","exp":9999999999}
        with patch.object(v.keys,"get_signing_key_from_jwt",return_value=SimpleNamespace(key="key")), patch("jwt.decode",return_value=claims) as decode:
            self.assertIsNotNone(await v.verify_token("jwt"))
            self.assertEqual(decode.call_args.kwargs["audience"],"client")
            self.assertEqual(decode.call_args.kwargs["issuer"],v.issuer)
            for field, value in [("tid","other"),("oid","other"),("scp","other")]:
                with patch.dict(claims,{field:value}):
                    self.assertIsNone(await v.verify_token("jwt"))

    @patch.dict(os.environ,{"P4_OAUTH_ENABLED":"true"})
    @patch("monthly_close_agent.mcp_server.generate",new_callable=AsyncMock)
    async def test_no_paid_call_without_oauth(self, generate):
        with self.assertRaisesRegex(ValueError,"USER_OAUTH_REQUIRED"):
            await commercial_analyze("investigación","P4_RESEARCH","objetivo")
        generate.assert_not_awaited()

    @patch.dict(os.environ,{"P4_OAUTH_ENABLED":"true","P4_PUBLIC_HOST":"p4.example.test",
        "P4_ENTRA_TENANT_ID":"tenant","P4_ENTRA_CLIENT_ID":"client","P4_ALLOWED_OIDS":"user",
        "P4_API_TOKEN":"probe","OPENAI_API_KEY":"test","OPENAI_MODEL":"gpt-5.1","MCP_URL":"https://example.test/mcp"})
    async def test_resource_metadata_and_auth(self):
        with TestClient(create_app(),base_url="https://p4.example.test") as client:
            meta=client.get("/.well-known/oauth-protected-resource/mcp")
            self.assertEqual(meta.status_code,200)
            self.assertEqual(meta.json()["resource"],"https://p4.example.test/mcp")
            headers={"Accept":"application/json, text/event-stream"}
            body={"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
            self.assertEqual(client.post("/mcp",headers=headers,json=body).status_code,401)
            headers["Authorization"]="Bearer probe"
            self.assertEqual(client.post("/mcp",headers=headers,json=body).status_code,200)
