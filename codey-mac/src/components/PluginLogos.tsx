import React from 'react'

type PluginLogoProps = {
  id: string
  size?: number
}

/** Product-specific plugin marks. Keeping them as SVG components makes the
 *  plugin list crisp at every display scale and avoids another asset bundle. */
export const PluginLogo: React.FC<PluginLogoProps> = ({ id, size = 32 }) => {
  if (id === 'chrome-companion') return <ChromeCompanionLogo size={size} />
  if (id === 'browser') return <BrowserLogo size={size} />
  if (id === 'terminal') return <TerminalLogo size={size} />
  return <FallbackLogo size={size} />
}

const TerminalLogo: React.FC<{ size: number }> = ({ size }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="1" y="2" width="30" height="28" rx="8" fill="#1F2430" />
    <rect x="1.5" y="2.5" width="29" height="27" rx="7.5" stroke="#3A4152" />
    <path d="m8 12 5 4-5 4" stroke="#5EE071" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 21h8" stroke="#E6E6E6" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

/** A globe on a blue tile, with a pointer resting on it: the web, driven by
 *  an agent. Same tile shape as the Terminal mark so the list reads as a set. */
const BrowserLogo: React.FC<{ size: number }> = ({ size }) => {
  const gradientId = `browser-logo-${React.useId().replace(/:/g, '')}`
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="16" y1="2" x2="16" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4F8BFF" />
          <stop offset="1" stopColor="#2457E6" />
        </linearGradient>
      </defs>
      <rect x="1" y="2" width="30" height="28" rx="8" fill={`url(#${gradientId})`} />
      <g stroke="white" strokeWidth="1.7" strokeLinecap="round">
        <circle cx="15" cy="15" r="8" />
        <ellipse cx="15" cy="15" rx="3.4" ry="8" />
        <path d="M7.4 12.4h15.2M7.4 17.6h15.2" />
      </g>
      <path
        d="M18.3 17.3 27.4 20.9l-4 1.6-1.6 4Z"
        fill="white"
        stroke="#2457E6"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const ChromeCompanionLogo: React.FC<{ size: number }> = ({ size }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="16" cy="16" r="14.5" fill="#F4F7FB" stroke="#D8DEE9" />
    <circle cx="16" cy="16" r="10.5" stroke="#EA4335" strokeWidth="6" pathLength="100" strokeDasharray="31 69" transform="rotate(-90 16 16)" />
    <circle cx="16" cy="16" r="10.5" stroke="#FBBC04" strokeWidth="6" pathLength="100" strokeDasharray="31 69" transform="rotate(30 16 16)" />
    <circle cx="16" cy="16" r="10.5" stroke="#34A853" strokeWidth="6" pathLength="100" strokeDasharray="31 69" transform="rotate(150 16 16)" />
    <circle cx="16" cy="16" r="6.3" fill="white" />
    <circle cx="16" cy="16" r="5.1" fill="#4285F4" />
    <circle cx="24.5" cy="24.5" r="6" fill="#6558F5" stroke="white" strokeWidth="1.5" />
    <path d="M22.2 24.5h4.6M24.5 22.2v4.6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)

const FallbackLogo: React.FC<{ size: number }> = ({ size }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#6558F5" />
    <path d="M10 16h12M16 10v12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
)
