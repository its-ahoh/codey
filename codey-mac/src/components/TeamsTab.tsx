import React from 'react'
import GlobalTeamsSection from './GlobalTeamsSection'
import { pageIntroStyle, pageStyle } from './settingsAtoms'

export const TeamsTab: React.FC = () => {
  return (
    <div style={pageStyle}>
      <div style={pageIntroStyle}>Compose specialist workers into reusable delivery teams.</div>
      <GlobalTeamsSection />
    </div>
  )
}
