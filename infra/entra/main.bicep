// main.bicep — Helix Entra ID app registrations (M5+).
//
// The three OIDC clients (architecture §4.2) declared via the Microsoft Graph
// Bicep extension (GA 2025-07-29). This is the IaC form of the manual runbook,
// docs/runbooks/entra-app-registration.md — every gotcha we hit by hand is a
// declared property here.
//
// STATUS: reference / not yet wired into a pipeline. The pilot tenant's three
// apps were created by hand; this is "our best shot" for the NEXT environment
// (staging/prod), where reproducibility pays. See README.md for why we don't
// retro-import the hand-made ones, and for the deploy-principal Graph
// permissions this requires.
//
// Outputs (client ids + audience) are meant to feed the sibling Azure stack's
// params: edgeOidcClientId, portalOidcAudience, azxWebClientId, azxCliClientId.

targetScope = 'resourceGroup' // Graph resources are tenant objects; the ARM
// scope is irrelevant to them — RG scope just lets you `az deployment group
// create` this alongside the rest.

extension microsoftGraphV1 // configured in bicepconfig.json

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Name prefix for the registrations, e.g. "helix-staging".')
param namePrefix string = 'helix-staging'

@description('Redirect URIs for the edge confidential web client (the auth host callback).')
param edgeRedirectUris array = [
  'https://auth.staging.azx-labs.com/callback'
]

@description('Redirect URIs for the portal SPA (browser code+PKCE callback).')
param portalSpaRedirectUris array = [
  'https://portal.staging.azx-labs.com/auth/callback'
]

@description('Base64 of the edge public certificate (DER/.cer) for private_key_jwt. Empty = add the keyCredential later. The PRIVATE key goes to Key Vault for the running edge, never here.')
param edgeCertificateBase64 string = ''

@description('Object id of the user OR group to grant the platform-admin app role. Empty = assign by hand later (the least-generic step).')
param adminPrincipalId string = ''

@description('Pre-grant admin consent for the CLI -> portal API scope (else each user consents at first login).')
param grantAdminConsent bool = false

// Stable GUIDs for the scope + role (deterministic so re-deploys don't churn them).
var portalAccessScopeId = guid(namePrefix, 'portal', 'scope', 'access')
var platformAdminRoleId = guid(namePrefix, 'portal', 'role', 'platform-admin')

// ---------------------------------------------------------------------------
// Reg 1 — helix-edge (app-user SSO; confidential web client, certificate auth)
// ---------------------------------------------------------------------------

resource edgeApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-edge'
  displayName: '${namePrefix}-edge'
  signInAudience: 'AzureADMyOrg' // single tenant
  web: {
    redirectUris: edgeRedirectUris
  }
  // The edge reads only the ID token; email enriches the display name (UPN is
  // always present, so this just adds the real email when available).
  optionalClaims: {
    idToken: [
      { name: 'email', essential: false }
    ]
  }
  // Certificate (private_key_jwt) — the tenant blocks client secrets. Only the
  // PUBLIC cert lives on the registration; the edge holds the private key (from
  // Key Vault). Add the keyCredential here when the cert exists.
  keyCredentials: empty(edgeCertificateBase64) ? [] : [
    {
      type: 'AsymmetricX509Cert'
      usage: 'Verify'
      key: edgeCertificateBase64
      displayName: 'CN=${namePrefix}-edge'
    }
  ]
  // No app roles for the pilot — they're only needed for `visibility: group`
  // apps (deferred). Add an appRoles[] entry per group when that lands.
}

resource edgeSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: edgeApp.appId
}

// --- Alternative to the certificate: a federated identity credential ---------
// Cleaner for prod (no key material anywhere) — the edge's ACA managed identity
// proves its identity directly. NOT enabled: it needs edge code to fetch the
// managed-identity token and present it as the OIDC client_assertion (a new
// client-auth mode beyond secret/cert in apps/edge/src/auth/oidc.ts). Left here
// as the documented upgrade path:
//
// resource edgeFic 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
//   parent: edgeApp
//   name: '${namePrefix}-edge-managed-identity'
//   issuer: '<the edge user-assigned identity issuer>'
//   subject: '<the edge user-assigned identity subject>'
//   audiences: ['api://AzureADTokenExchange']
// }

// ---------------------------------------------------------------------------
// Reg 2 — helix-portal (SPA client + the API its tokens target)
// ---------------------------------------------------------------------------

resource portalApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-portal'
  displayName: '${namePrefix}-portal'
  signInAudience: 'AzureADMyOrg'
  spa: {
    // SPA platform => Entra serves CORS on the token endpoint + enforces PKCE
    // (replaces the dev-idp clientBasedCORS hack).
    redirectUris: portalSpaRedirectUris
  }
  api: {
    // CRITICAL: v2 tokens, so the access token's `iss` is the v2 issuer the
    // portal verifies against. Default (1) issues sts.windows.net tokens -> 401.
    // Consequence: a v2 access token's `aud` is the bare client-id GUID (NOT the
    // api:// URI), so PORTAL_OIDC_AUDIENCE = portalApp.appId (see outputs).
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: portalAccessScopeId
        value: 'access'
        type: 'User' // admins-and-users consent
        isEnabled: true
        adminConsentDisplayName: 'Access the Helix portal API'
        adminConsentDescription: 'Allows the signed-in user to access the Helix portal API on their behalf.'
        userConsentDisplayName: 'Access the Helix portal'
        userConsentDescription: 'Allows the app to access the Helix portal API on your behalf.'
      }
    ]
  }
  // Admin gating rides the `roles` claim (App Roles, not security groups — no
  // GUIDs, no Graph lookups, no group-overage). PORTAL_ADMIN_GROUP_ID = 'platform-admin'.
  appRoles: [
    {
      id: platformAdminRoleId
      value: 'platform-admin'
      allowedMemberTypes: [ 'User' ]
      isEnabled: true
      displayName: 'Platform Admin'
      description: 'Helix platform administrators (approvals, secrets, admin pages).'
    }
  ]
  optionalClaims: {
    idToken: [ { name: 'email', essential: false } ]
    accessToken: [ { name: 'email', essential: false } ]
  }
  // identifierUris MUST be ['api://${portalApp.appId}'] so clients can request
  // the `api://<id>/access` scope — BUT Bicep can't self-reference appId within
  // the same resource. Options: (a) a one-time post-deploy
  //   `az ad app update --id <portalClientId> --identifier-uris api://<portalClientId>`
  // or (b) a second deployment pass that sets it. The portal UI sets this
  // automatically when you add a scope; Bicep does not. Tracked as a known wart.
}

resource portalSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: portalApp.appId
}

// Assign the admin principal (user or group) to the platform-admin role. This is
// the least-generic part — it couples to a specific object id. Assign-by-group
// keeps membership in the directory; assign-by-user works on the free tier.
resource adminRoleAssignment 'Microsoft.Graph/appRoleAssignedTo@v1.0' = if (!empty(adminPrincipalId)) {
  appRoleId: platformAdminRoleId
  principalId: adminPrincipalId
  resourceId: portalSp.id
}

// ---------------------------------------------------------------------------
// Reg 3 — azx-cli (device-code public client)
// ---------------------------------------------------------------------------

resource cliApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: '${namePrefix}-cli'
  displayName: '${namePrefix}-cli'
  signInAudience: 'AzureADMyOrg'
  isFallbackPublicClient: true // "Allow public client flows" = Yes (device code)
  // Delegated permission to the portal's `access` scope, so the CLI's token is
  // portal-audienced. (The SPA gets the same scope via dynamic consent and needs
  // no pre-grant.)
  requiredResourceAccess: [
    {
      resourceAppId: portalApp.appId
      resourceAccess: [
        { id: portalAccessScopeId, type: 'Scope' }
      ]
    }
  ]
}

resource cliSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: cliApp.appId
}

// Optional: pre-consent the CLI->portal scope for the whole tenant (else each
// user consents once at first `azx login`). Requires the deploy principal to be
// able to grant consent.
resource cliConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = if (grantAdminConsent) {
  clientId: cliSp.id
  consentType: 'AllPrincipals'
  resourceId: portalSp.id
  scope: 'access'
}

// ---------------------------------------------------------------------------
// Outputs — feed these into the sibling Azure stack's params (../azure)
// ---------------------------------------------------------------------------

output edgeOidcClientId string = edgeApp.appId
output portalClientId string = portalApp.appId
// v2 access tokens carry aud = client id, so the portal's expected audience IS
// the portal client id (not api://...).
output portalOidcAudience string = portalApp.appId
output azxWebClientId string = portalApp.appId
output azxCliClientId string = cliApp.appId
output portalApiScope string = 'api://${portalApp.appId}/access'
