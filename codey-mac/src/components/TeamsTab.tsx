import React from 'react'
import GlobalTeamsSection from './GlobalTeamsSection'
import { pageStyle } from './settingsAtoms'

export const TeamsTab: React.FC = () => {
  return (
    <div style={pageStyle}>
      <GlobalTeamsSection />
    </div>
  )
}
