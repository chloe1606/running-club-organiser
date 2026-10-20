export function RunningLoader({ message = "Loading your club runs..." }: { message?: string }) {
  return <div className="running-loader" role="status" aria-live="polite">
    <svg className="running-loader-icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g className="runner-body">
        <g className="runner-arm runner-arm-back" opacity=".8"><path d="m34 22 0 11 10 2" /></g>
        <g className="runner-leg runner-leg-back" opacity=".8"><path d="m28 35 0 13-8 8" /></g>
        <circle cx="39" cy="10" r="5" fill="currentColor" stroke="none" />
        <path d="M35 20 28 35" />
        <g className="runner-arm runner-arm-front"><path d="m34 22 0 11 10 2" /></g>
        <g className="runner-leg runner-leg-front"><path d="m28 35 0 13-8 8" /></g>
      </g>
    </svg>
    <p className="sr-only">{message}</p>
  </div>;
}
