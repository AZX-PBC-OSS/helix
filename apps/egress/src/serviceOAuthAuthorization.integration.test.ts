import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { MockAgent, type Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import { PgSecretResolver } from "./secrets.js";

const ownerUrl = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
const u = new URL(ownerUrl);
u.username = "helix_egress";
u.password = "helix_egress";
const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
const resolver = new PgSecretResolver(u.href, store, { max: 2, tokenStore: store });
const dispatcher = new MockAgent();
dispatcher.disableNetConnect();
const transport = { dispatcher: dispatcher as unknown as Agent };
const appIds = [randomUUID(), randomUUID()];
const secretId = randomUUID(),
  name = `oauth-${secretId}`;
const origin = "https://api.example";
const recipe = {
  kind: "oauth-service-account",
  tokenEndpoint: "https://identity.example/token",
  grantType: "password",
  clientAuthentication: "none",
};
let tokenCalls = 0;
beforeAll(async () => {
  dispatcher
    .get("https://identity.example")
    .intercept({ path: "/token", method: "POST" })
    .reply(() => {
      tokenCalls++;
      return {
        statusCode: 200,
        data: { access_token: "issued-token", token_type: "Bearer", expires_in: 3600 },
      };
    })
    .persist();
  for (const id of appIds)
    await owner.query(
      `INSERT INTO apps(id,slug,"displayName","visibilityMode","updatedAt") VALUES($1,$2,'OAuth Authz','internal',now())`,
      [id, `oauth-${id}`],
    );
  await owner.query(
    `INSERT INTO app_secrets(id,scope,env,name,material,injection,"createdBy") VALUES($1,'global','prod',$2,$3,$4,'test')`,
    [
      secretId,
      name,
      await store.seal(JSON.stringify({ kind: recipe.kind, username: "u", password: "p" })),
      recipe,
    ],
  );
  for (const appId of appIds) {
    await owner.query(
      `INSERT INTO app_secret_grants("appId","secretId","grantedBy") VALUES($1,$2,'test')`,
      [appId, secretId],
    );
    await owner.query(
      `INSERT INTO secret_connection_bindings("appId",origin,name,env,"secretId") VALUES($1,$2,$3,'prod',$4)`,
      [appId, origin, name, secretId],
    );
  }
});
afterAll(async () => {
  await resolver.close();
  await dispatcher.close();
  await owner.query("DELETE FROM app_secrets WHERE id=$1", [secretId]);
  await owner.query("DELETE FROM apps WHERE id=ANY($1::uuid[])", [appIds]);
  await owner.end();
});
const resolve = (appId = appIds[0]!, env: "prod" | "dev" = "prod", targetOrigin = origin) =>
  resolver.resolve(appId, name, "fetch", env, targetOrigin, transport);

describe("service-account authorization on cache hits", () => {
  it("shares one global token across grantees while separating environment and origin", async () => {
    expect((await resolve())?.value).toBe("issued-token");
    expect((await resolve(appIds[1]))?.value).toBe("issued-token");
    expect(tokenCalls).toBe(1);
    expect(await resolve(appIds[0], "dev")).toBeNull();
    expect(await resolve(appIds[0], "prod", "https://other.example")).toBeNull();
    expect(await resolver.resolve(appIds[0]!, name, "llm", "prod", origin, transport)).toBeNull();
  });
  it("fails closed without writable token custody even when configured credentials exist", async () => {
    const readonlyResolver = new PgSecretResolver(u.href, store);
    try {
      await expect(
        readonlyResolver.resolve(appIds[0]!, name, "fetch", "prod", origin, transport),
      ).rejects.toMatchObject({ outcome: "temporary_failure" });
    } finally {
      await readonlyResolver.close();
    }
  });
  it("revokes one grantee immediately without affecting other grantees", async () => {
    await owner.query(`DELETE FROM app_secret_grants WHERE "appId"=$1 AND "secretId"=$2`, [
      appIds[0],
      secretId,
    ]);
    expect(await resolve()).toBeNull();
    expect((await resolve(appIds[1]))?.value).toBe("issued-token");
    expect(tokenCalls).toBe(1);
  });
  it("permits static global shadowing and same-name app replacement without an OAuth fence", async () => {
    const id = randomUUID(),
      staticName = `static-${id}`;
    await owner.query(
      `INSERT INTO app_secrets(id,scope,env,name,material,injection,"createdBy") VALUES($1,'global','prod',$2,$3,$4,'test')`,
      [id, staticName, await store.seal("global"), { kind: "header-bearer" }],
    );
    try {
      await owner.query(
        `INSERT INTO app_secret_grants("appId","secretId","grantedBy") VALUES($1,$2,'test')`,
        [appIds[1], id],
      );
      const read = () =>
        resolver.resolve(appIds[1]!, staticName, "fetch", "prod", origin, transport);
      expect((await read())?.value).toBe("global");
      for (const value of ["shadow", "replacement"]) {
        await owner.query(`DELETE FROM app_secrets WHERE "appId"=$1 AND name=$2`, [
          appIds[1],
          staticName,
        ]);
        await owner.query(
          `INSERT INTO app_secrets(id,scope,"appId",env,name,material,injection,"createdBy") VALUES($1,'app',$2,'prod',$3,$4,$5,'test')`,
          [randomUUID(), appIds[1], staticName, await store.seal(value), { kind: "header-bearer" }],
        );
        expect((await read())?.value).toBe(value);
      }
    } finally {
      await owner.query("DELETE FROM app_secrets WHERE id=$1", [id]);
    }
  });
  it("does not permit a same-name app secret to inherit the approved global identity", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO app_secrets(id,scope,"appId",env,name,material,injection,"createdBy") VALUES($1,'app',$2,'prod',$3,$4,$5,'test')`,
      [id, appIds[1], name, await store.seal("static-value"), { kind: "header-bearer" }],
    );
    expect(await resolve(appIds[1])).toBeNull();
    expect(tokenCalls).toBe(1);
  });
});
