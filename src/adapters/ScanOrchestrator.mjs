import { SecretsAdapter } from './secrets/SecretsAdapter.mjs';
import { GarakAdapter } from './garak/GarakAdapter.mjs';
import { AgentHarmAdapter } from './agentharm/AgentHarmAdapter.mjs';
import { PromptGuardAdapter } from './promptguard/PromptGuardAdapter.mjs';

export const adapterRegistry = {
  [SecretsAdapter.id]: SecretsAdapter,
  [GarakAdapter.id]: GarakAdapter,
  [AgentHarmAdapter.id]: AgentHarmAdapter,
  [PromptGuardAdapter.id]: PromptGuardAdapter
};

const groupFindingsByCategory = (results) => {
  const groups = {};

  for (const result of results) {
    for (const finding of result.findings) {
      if (!groups[finding.category]) {
        groups[finding.category] = [];
      }

      groups[finding.category].push({
        adapter: result.adapter,
        ...finding
      });
    }
  }

  return groups;
};

const runSingleAdapter = async ({ adapter, target, options }) => {
  const available = await adapter.isAvailable();
  if (!available) {
    return null;
  }

  return adapter.run(target, options);
};

export const runAdapterScan = async ({ target, enabledAdapters, adapterOptions = {} }) => {
  const selectedIds = enabledAdapters?.length ? enabledAdapters : Object.keys(adapterRegistry);
  const adapterInstances = selectedIds.map((id) => {
    const AdapterClass = adapterRegistry[id];
    if (!AdapterClass) {
      throw new Error(`Unknown adapter id "${id}".`);
    }

    return new AdapterClass();
  });

  const settled = await Promise.allSettled(
    adapterInstances.map((adapter) =>
      runSingleAdapter({
        adapter,
        target,
        options: adapterOptions[adapter.getMetadata().id] ?? {}
      })
    )
  );

  const adapterResults = [];
  const errors = [];

  settled.forEach((result, index) => {
    const adapterId = adapterInstances[index].getMetadata().id;

    if (result.status === 'fulfilled' && result.value) {
      adapterResults.push(result.value);
      return;
    }

    if (result.status === 'rejected') {
      errors.push({
        adapter: adapterId,
        message: result.reason?.message ?? 'Unknown adapter error'
      });
    }
  });

  return {
    target,
    adapters: adapterResults,
    groupedFindings: groupFindingsByCategory(adapterResults),
    errors
  };
};
