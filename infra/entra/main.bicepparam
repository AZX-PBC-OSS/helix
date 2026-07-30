using './main.bicep'

// Per-deployment registration config. namePrefix keys the uniqueNames, so keep
// it distinct per deployment (helix-prod here; a customer-cloud install would use
// its own, e.g. helix-<customer> — see ADR-0028).
param namePrefix = 'helix-prod'

// Redirect URIs per environment. For a LOCAL-against-Entra test you'd instead
// use the dev URIs (https://auth.local.helix.azxlabs.io:8080/callback for edge;
// http://localhost:5173/auth/callback + http://localhost:3001/auth/callback for
// the portal SPA) — but the pilot already has those on hand-made apps.
param edgeRedirectUris = [ 'https://auth.azx.helix.azxlabs.io/callback' ]
param portalSpaRedirectUris = [ 'https://portal.azx.helix.azxlabs.io/auth/callback' ]

// Edge public certificate (base64 of the DER/.cer). The matching private key
// goes to the Azure stack's Key Vault, never here. Empty = add the keyCredential
// to the edge registration later.
param edgeCertificateBase64 = readEnvironmentVariable('HELIX_EDGE_CERT_BASE64', '')

// Object id of the user or group to grant platform-admin. Empty = assign by hand.
param adminPrincipalId = readEnvironmentVariable('HELIX_ADMIN_PRINCIPAL_ID', '')

// Pre-grant tenant-wide consent for CLI -> portal scope (needs an admin deploy
// principal). false = users consent at first `helix login`.
param grantAdminConsent = false
