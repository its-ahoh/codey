import React from 'react'
import { C } from '../theme'
import { pageStyle, Section } from './settingsAtoms'
import { CodeyMemorySettings } from './CodeyMemorySection'
import { GlobalMemoryPanel, UserMemorySection } from './AgentMemorySection'

/**
 * Settings ▸ Memory — the user's global memory in one place.
 *
 *   Your memory  what Codey remembers about you everywhere (plus the global
 *                instruction file each agent loads on its own).
 *
 * Workspace-scoped memory lives on the Workspaces tab, next to the folders it
 * belongs to.
 */

interface Props {
  isGatewayRunning: boolean
}

export const MemoryTab: React.FC<Props> = ({ isGatewayRunning }) => {
  if (!isGatewayRunning) {
    return (
      <div style={pageStyle}>
        <div style={{ marginTop: 40, textAlign: 'center', color: C.fg3, fontSize: 13 }}>Gateway not available</div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <Section
        first
        title="Your memory"
        description="What Codey remembers about you everywhere, and what each agent already knows about you."
      />
      <CodeyMemorySettings />
      <GlobalMemoryPanel />
      <div style={{ marginTop: 12 }}>
        <UserMemorySection />
      </div>
    </div>
  )
}
