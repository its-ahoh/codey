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
  return <FallbackLogo size={size} />
}

const BrowserLogo: React.FC<{ size: number }> = ({ size }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="1" y="2" width="30" height="28" rx="8" fill="#6558F5" />
    <path d="M1 9.5h30V22a8 8 0 0 1-8 8H9a8 8 0 0 1-8-8V9.5Z" fill="#3B82F6" />
    <circle cx="6" cy="6" r="1.25" fill="#FCA5A5" />
    <circle cx="10" cy="6" r="1.25" fill="#FDE68A" />
    <circle cx="14" cy="6" r="1.25" fill="#86EFAC" />
    <path
      d="m17.1 12.3 7.6 3.15c.7.29.71 1.27.02 1.58l-2.91 1.29 2.34 2.34a1 1 0 0 1 0 1.41l-1.08 1.08a1 1 0 0 1-1.41 0l-2.34-2.34-1.29 2.91c-.31.69-1.29.68-1.58-.02l-3.15-7.6a2.94 2.94 0 0 1 3.8-3.8Z"
      fill="white"
      stroke="#DBEAFE"
      strokeWidth=".65"
      strokeLinejoin="round"
    />
  </svg>
)

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
