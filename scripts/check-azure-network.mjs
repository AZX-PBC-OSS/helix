// Evaluate the real deployment locally; no Azure credentials or resources are used.
// Bicep 0.48.1 supplies the snapshot evaluator (also pinned in the Bicep CI job).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(root, "infra/azure/main.bicep");
const bicep =
  process.env.BICEP_BINARY ??
  join(process.env.AZURE_CONFIG_DIR ?? join(homedir(), ".azure"), "bin/bicep");
const scratch = mkdtempSync(join(tmpdir(), "helix-network-check-"));
const conflict = "deployNatGateway and deployFirewall cannot both be true";

function run(args) {
  const result = spawnSync(bicep, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function literal(value) {
  if (typeof value === "string") return `'${value.replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  return String(value);
}

try {
  const build = run(["build", main, "--stdout"]);
  assert.equal(build.status, 0, build.stderr);
  const template = JSON.parse(build.stdout);
  // Supply synthetic values for required inputs, never secrets from the environment.
  const required = Object.entries(template.parameters).filter(
    ([, param]) => !Object.hasOwn(param, "defaultValue"),
  );
  const defaults = Object.fromEntries(
    required.map(([name, param], index) => {
      assert.ok(["string", "securestring"].includes(param.type), name);
      return [name, `helixtest${index}`];
    }),
  );

  function snapshot(label, params, expectConflict = false) {
    const path = join(scratch, `${label}.bicepparam`);
    const values = {
      ...defaults,
      location: "westeurope",
      namePrefix: "helix-test",
      budgetStartDate: "2026-11-01",
      deployTelemetry: false,
      alertEmails: ["network-test@example.invalid"],
      ...params,
    };
    writeFileSync(
      path,
      `using '${relative(scratch, main)}'\n` +
        Object.entries(values)
          .map(([key, value]) => `param ${key} = ${literal(value)}\n`)
          .join(""),
    );
    const result = run([
      "snapshot",
      path,
      "--subscription-id",
      "00000000-0000-0000-0000-000000000000",
      "--tenant-id",
      "00000000-0000-0000-0000-000000000000",
      "--resource-group",
      "helix-network-test",
      "--location",
      "westeurope",
    ]);
    if (expectConflict) {
      assert.notEqual(result.status, 0, `${label}: expected rejection`);
      assert.ok(result.stderr.includes(conflict), result.stderr);
      console.log(`PASS ${label}: conflicting options rejected`);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const evaluated = JSON.parse(
      readFileSync(path.replace(".bicepparam", ".snapshot.json"), "utf8"),
    );
    // Live properties (allocated IPs, identities, vault data) remain unresolved.
    // The assertions below require the networking, budget and alerts to expand.
    return evaluated;
  }

  function check(label, params, firewall, nat) {
    const { predictedResources: resources, outputs } = snapshot(label, params);
    const ofType = (type) => resources.filter((r) => r.type === type);
    const gateways = ofType("Microsoft.Network/natGateways");
    assert.equal(gateways.length, nat ? 1 : 0, label);
    assert.equal(ofType("Microsoft.Network/azureFirewalls").length, firewall ? 1 : 0);
    assert.equal(ofType("Microsoft.Network/routeTables/routes").length, firewall ? 2 : 0);
    const subnets = ofType("Microsoft.Network/virtualNetworks")[0].properties.subnets;
    const attached = subnets.filter((s) => s.properties.natGateway);
    assert.deepEqual(
      attached.map((s) => s.name),
      nat ? ["snet-egress"] : [],
    );
    if (nat) {
      const gateway = gateways[0];
      const ips = ofType("Microsoft.Network/publicIPAddresses");
      assert.equal(ips.length, 1);
      assert.equal(ips[0].sku.name, "Standard");
      assert.equal(ips[0].properties.publicIPAllocationMethod, "Static");
      assert.equal(ips[0].properties.publicIPAddressVersion, "IPv4");
      assert.equal(gateway.sku.name, "Standard");
      assert.deepEqual(gateway.properties.publicIpAddresses, [{ id: ips[0].id }]);
      assert.equal(attached[0].properties.natGateway.id, gateway.id);
      assert.ok(outputs.egressNatPublicIp.includes(ips[0].id));
    } else {
      assert.equal(outputs.egressNatPublicIp, "");
    }
    const expected = 125 + (firewall ? 920 : 0) + (nat ? (params.natGatewayMonthlyUsd ?? 40) : 0);
    assert.equal(outputs.expectedMonthlyUsd, expected);
    assert.equal(outputs.costBudgetUsd, params.monthlyCostBudgetUsd ?? Math.floor(expected * 1.6));
    const alerts = ofType("Microsoft.Insights/metricAlerts").filter((r) =>
      r.name.includes("-alert-nat-"),
    );
    const expectAlerts = nat && params.deployApps && params.deployInfraAlerts !== false;
    assert.equal(alerts.length, expectAlerts ? 2 : 0);
    if (expectAlerts) {
      for (const alert of alerts) {
        assert.deepEqual(alert.properties.scopes, [gateways[0].id]);
        assert.equal(alert.properties.severity, 2);
        assert.equal(alert.properties.autoMitigate, true);
        assert.equal(alert.properties.evaluationFrequency, "PT1M");
        assert.equal(alert.properties.actions.length, 1);
      }
      const availability = alerts.find((a) => a.name.endsWith("-unavailable"));
      const failures = alerts.find((a) => a.name.endsWith("-failed-connections"));
      assert.equal(availability.properties.windowSize, "PT15M");
      assert.equal(failures.properties.windowSize, "PT5M");
      const available = availability.properties.criteria.allOf[0];
      assert.equal(available.metricName, "DatapathAvailability");
      assert.equal(available.timeAggregation, "Average");
      assert.equal(available.operator, "LessThan");
      assert.equal(available.threshold, 90);
      const failed = failures.properties.criteria.allOf[0];
      assert.equal(failed.metricName, "SNATConnectionCount");
      assert.equal(failed.timeAggregation, "Total");
      assert.equal(failed.operator, "GreaterThan");
      assert.equal(failed.threshold, 0);
      assert.deepEqual(failed.dimensions, [
        { name: "ConnectionState", operator: "Include", values: ["Failed"] },
      ]);
    }
    console.log(`PASS ${label}: networking, budget, output and alerts`);
    return { subnets, environments: ofType("Microsoft.App/managedEnvironments") };
  }

  for (const deployApps of [false, true]) {
    const phase = deployApps ? "apps" : "bootstrap";
    check(`${phase}-defaults`, { deployApps }, true, false);
    const off = check(
      `${phase}-off`,
      { deployApps, deployFirewall: false, deployNatGateway: false },
      false,
      false,
    );
    const nat = check(
      `${phase}-nat`,
      { deployApps, deployFirewall: false, deployNatGateway: true },
      false,
      true,
    );
    assert.deepEqual(nat.environments, off.environments, "NAT must not change ACA environments");
    assert.deepEqual(
      nat.subnets.filter((s) => s.name !== "snet-egress"),
      off.subnets.filter((s) => s.name !== "snet-egress"),
    );
    snapshot(
      `${phase}-conflict`,
      { deployApps, deployFirewall: true, deployNatGateway: true },
      true,
    );
  }
  check(
    "nat-budget-override-alerts-off",
    {
      deployApps: true,
      deployFirewall: false,
      deployNatGateway: true,
      natGatewayMonthlyUsd: 75,
      monthlyCostBudgetUsd: 400,
      deployInfraAlerts: false,
    },
    false,
    true,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
