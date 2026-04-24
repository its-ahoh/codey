// Mimics codey-mac's bootInProcessCore to isolate whether the failure
// is in the core logic or Electron-specific. Run from repo root:
//   npx ts-node --project packages/gateway/tsconfig.json scripts/verify-mac-boot.ts

import { join } from 'path'
import { WorkerManager, WorkspaceManager } from '@codey/core'
import { ConfigManager } from '@codey/gateway/dist/config'
import { Codey } from '@codey/gateway/dist/gateway'

async function main() {
  // Simulate __dirname being codey-mac/dist-electron/
  const dirname = join(process.cwd(), 'codey-mac', 'dist-electron')
  const root = join(dirname, '..', '..')
  console.log('[diag] resolved root:', root)
  console.log('[diag] gateway.json path:', join(root, 'gateway.json'))

  const cm = new ConfigManager(join(root, 'gateway.json'))
  const json = cm.get()
  console.log('[diag] loaded config defaultAgent:', json?.gateway?.defaultAgent)
  console.log('[diag] model catalog:', JSON.stringify(cm.listModels().map(m => ({ name: m.name, apiType: m.apiType, model: m.model, baseUrl: m.baseUrl, hasKey: !!m.apiKey })), null, 2))
  console.log('[diag] fallback:', cm.getFallback())

  const wm = new WorkerManager(join(root, 'workers'))
  await wm.loadWorkers()
  console.log('[diag] workers loaded:', wm.getAllWorkers().map(w => w.name))

  const wsm = new WorkspaceManager(wm, join(root, 'workspaces'))
  await wsm.switchWorkspace(wsm.getCurrentWorkspace())
  console.log('[diag] workspace list:', wsm.listWorkspaces())
  console.log('[diag] current workspace:', wsm.getCurrentWorkspace())
  console.log('[diag] teams:', wsm.getTeams())

  const runtime: any = {
    port: json?.gateway?.port,
    defaultAgent: json?.gateway?.defaultAgent,
    agents: json?.agents,
    channels: {},
  }
  const codey = new Codey(runtime, undefined as any, join(root, 'workspaces'), cm, wm)
  console.log('[diag] Codey constructed ok, defaultAgent on config:', (codey as any).config?.defaultAgent)

  const modelCfg = (codey as any).getDefaultModelConfig?.('claude-code')
  console.log('[diag] resolved ModelConfig for claude-code:', modelCfg ? {
    provider: modelCfg.provider,
    model: modelCfg.model,
    apiType: modelCfg.apiType,
    baseUrl: modelCfg.baseUrl,
    apiKeyPrefix: modelCfg.apiKey?.slice(0, 10) + '…',
  } : undefined)
}

main().catch(err => {
  console.error('[diag] FAILED:', err)
  process.exit(1)
})
