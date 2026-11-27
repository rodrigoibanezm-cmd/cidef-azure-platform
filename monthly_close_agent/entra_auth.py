"""Entra resource server, following the Salesforce Admin verifier pattern."""
import asyncio
import hmac
import logging
import os

import jwt
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings

log = logging.getLogger("cidef.p4.oauth")


class EntraVerifier(TokenVerifier):
    def __init__(self, tenant, audience, allowed_oids, probe_token):
        self.tenant = tenant
        self.audience = audience
        self.allowed_oids = allowed_oids
        self.probe_token = probe_token
        self.issuer = f"https://login.microsoftonline.com/{tenant}/v2.0"
        self.keys = jwt.PyJWKClient(
            f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
            cache_jwk_set=True, lifespan=3600)

    async def verify_token(self, token: str) -> AccessToken | None:
        # Retain existing authenticated deployment smoke checks. This identity
        # is restricted by the tool to DIRECT_MOTOR; it cannot invoke paid research.
        if self.probe_token and hmac.compare_digest(token, self.probe_token):
            return AccessToken(token=token, client_id="p4-deployment-probe",
                               scopes=["access_as_user"])
        try:
            key = await asyncio.to_thread(self.keys.get_signing_key_from_jwt, token)
            claims = jwt.decode(token, key.key, algorithms=["RS256"],
                                audience=self.audience, issuer=self.issuer,
                                options={"require":["exp","iat","aud","iss","tid","oid","scp"]})
            scopes = claims["scp"].split()
            if (claims["tid"] != self.tenant or
                claims["oid"].lower() not in self.allowed_oids or
                "access_as_user" not in scopes):
                return None
            return AccessToken(token=token, client_id=claims.get("azp", ""),
                               scopes=scopes, expires_at=claims["exp"])
        except (jwt.PyJWTError, ValueError, KeyError, TypeError) as exc:
            log.warning("oauth_token_rejected reason=%s", type(exc).__name__)
            return None


def entra_options(host):
    tenant = os.environ["P4_ENTRA_TENANT_ID"].strip()
    audience = os.environ["P4_ENTRA_CLIENT_ID"].strip()
    allowed = {x.strip().lower() for x in os.environ["P4_ALLOWED_OIDS"].split(",") if x.strip()}
    if not host or not tenant or not audience or not allowed:
        raise RuntimeError("P4_ENTRA_CONFIGURATION_REQUIRED")
    verifier = EntraVerifier(tenant, audience, allowed, os.getenv("P4_API_TOKEN"))
    return {
        "token_verifier": verifier,
        "auth": AuthSettings(issuer_url=verifier.issuer,
                             resource_server_url=f"https://{host}/mcp",
                             required_scopes=["access_as_user"],
                             validate_token_resource=False),
    }
