import type { ModelEntry } from '../../src/core/types.js';

/** Test-only factory. The `name` alias avoids clashing with the `model` field. */
export function makeModel(
  overrides: Partial<ModelEntry> & { provider: string; name: string },
): ModelEntry {
  const { provider, name, ...rest } = overrides;
  return {
    id: `${provider}/${name}`,
    provider,
    model: name,
    label: `${provider} ${name}`,
    capabilities: ['reasoning'],
    limits: { contextWindow: 128_000, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false },
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    strength: 0.7,
    source: 'dsh-config',
    ...rest,
  };
}

export const bigBrain = makeModel({
  provider: 'deepseek',
  name: 'reasoner',
  label: 'DeepSeek Reasoner',
  capabilities: ['reasoning', 'coding', 'writing'],
  pricing: { inputPerMTok: 2, outputPerMTok: 8 },
  strength: 0.9,
});

export const cheapFast = makeModel({
  provider: 'deepseek',
  name: 'flash',
  label: 'DeepSeek Flash',
  capabilities: ['cheap-bulk', 'summarizing'],
  pricing: { inputPerMTok: 0.1, outputPerMTok: 0.3 },
  strength: 0.6,
});

export const coder = makeModel({
  provider: 'local',
  name: 'qwen-coder',
  label: 'Qwen Coder (local)',
  capabilities: ['coding'],
  limits: { contextWindow: 32_000, maxOutputTokens: 4_096, supportsTools: true, supportsImages: false },
  pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  strength: 0.8,
});

export const painter = makeModel({
  provider: 'cloud',
  name: 'diffusion-xl',
  label: 'Diffusion XL',
  capabilities: ['image-generation', 'vision'],
  pricing: { inputPerMTok: 0, outputPerMTok: 40 },
  strength: 0.95,
});

export const allModels = [bigBrain, cheapFast, coder, painter];
