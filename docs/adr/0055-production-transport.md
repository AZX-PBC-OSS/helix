# 0055. Production transport protection

**Status:** Accepted

Production platform HTTP destinations use authenticated HTTPS. Azure also enables
peer traffic encryption in both Container Apps environments, protecting traffic
behind ingress termination. Application HTTP listeners remain behind that boundary.

Other operators may set `HELIX_INTERNAL_TRANSPORT_MODE=mesh` and provide
`HELIX_MESH_HTTP_ORIGINS`, a JSON array of exact HTTP origins. This is an operator
attestation of authenticated mesh encryption, not an application verification of
it. Wildcards, credentials, and paths are forbidden. HTTPS mode is the default.
Local development permits HTTP. External credential-free upstream policy is unchanged.

The exception applies to internal service and collector destinations only. Database
clients must verify their destination; Blob and Key Vault use HTTPS. Native Prisma
migrations use `sslmode=require&sslaccept=strict`; Node clients and psql use
`sslmode=verify-full`. Root trust stores must remain current; do not pin leaf certificates.

Managed identity endpoints and container probes are platform-managed exceptions.
Peer encryption coverage of probes is not asserted. Signatures, replay protection,
and authorization remain necessary independently of transport encryption.

Peer encryption is not transparent to the edge's client-IP derivation. An in-pod
proxy terminates the encrypted hop, so the application's socket peer becomes
loopback rather than the ingress. The Azure `edgeTrustProxy` default (`auto`)
therefore trusts `100.64.0.0/10,loopback` (ADR-0011). Loopback is reachable only
from inside the pod and is inert when encryption is off. Measured on a live
deployment: with the ingress range alone, no forwarded request resolved and the
trust-proxy alert fired.

Invalid service transport fails startup. Invalid telemetry destinations disable
export with a sanitized warning, preserving telemetry's availability boundary.
Live Azure verification remains required before issue #5 can be closed.

## Verification

The transport integration suite exercises real TLS handshakes against a local
TLS terminator forwarding to the test PostgreSQL server. Node pg, the Prisma pg
adapter, psql, and the native Prisma engine must accept the trusted certificate
and refuse expired, wrong-host, and untrusted certificates. Prisma's native
custom CA option is `sslcert`; Node pg uses `sslrootcert`. Tests never disable
certificate verification to exercise a production process.

## Connection inventory

| Connection | Protection |
| --- | --- |
| Edge/dev gateway → egress and portal | HTTPS plus managed peer encryption behind destination ingress |
| Edge/dev gateway → jobs | HTTPS plus managed peer encryption |
| Portal → egress OAuth exchange | HTTPS; redirects refused |
| Portal → jobs lifecycle delivery | HTTPS; redirects refused |
| Jobs → edge/dev gateway callbacks | HTTPS; redirects refused |
| Services → collector | HTTPS plus managed peer encryption; production mesh exception requires exact origin |
| Collector → Application Insights | Azure Monitor exporter with Azure-generated HTTPS ingestion destination |
| Runtime and migration clients → PostgreSQL | TLS with certificate and hostname validation, independent of mesh mode |
| Edge/portal → Blob | HTTPS; account requires HTTPS and TLS 1.2 minimum |
| Portal/egress and migration jobs → Key Vault | HTTPS; migration readers reject redirects |
| Authentication/directory → Entra and Graph | Existing HTTPS issuer/JWKS enforcement and Graph HTTPS origin |
| Egress → credential-backed API | Existing HTTPS enforcement; insecure override refused in production |
| Platform → managed identity endpoint | Platform-managed local HTTP exception |
| Platform health probes → container | Platform-managed HTTP exception; no encryption guarantee asserted |

The optional dev gateway has the same production checks as edge. Certificate
rotation uses managed ingress certificates and root trust stores. No application
certificate-distribution system or new signing scheme is introduced.
