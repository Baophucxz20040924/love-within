import './AuthBackdrop.css';

/** Decorative line art only: stays out of the accessibility tree and pointer/focus paths. */
export function AuthBackdrop({ friends }: { friends: boolean }) {
  return (
    <div className={`auth-backdrop${friends ? ' auth-backdrop--friends' : ''}`} aria-hidden="true">
      <div className="auth-backdrop__grain" />
      <div className="auth-backdrop__halo" />
      <svg className="auth-backdrop__orbits" viewBox="0 0 680 430" fill="none" focusable="false">
        <ellipse cx="340" cy="220" rx="290" ry="128" transform="rotate(-24 340 220)" />
        <ellipse cx="340" cy="220" rx="245" ry="172" transform="rotate(22 340 220)" />
        <ellipse className="auth-backdrop__dashed" cx="340" cy="220" rx="315" ry="198" transform="rotate(-8 340 220)" />
        <circle className="auth-backdrop__planet" cx="91" cy="266" r="8" />
        <circle className="auth-backdrop__planet auth-backdrop__planet--small" cx="568" cy="91" r="5" />
        <path className="auth-backdrop__spark" d="M113 106v16m-8-8h16M581 296v20m-10-10h20M496 47v10m-5-5h10" />
      </svg>
      <svg className="auth-backdrop__ribbon auth-backdrop__ribbon--left" viewBox="0 0 370 720" fill="none" focusable="false">
        <path className="auth-backdrop__wash" d="M-35 35C225-30 340 172 210 302S-68 468 104 724H-35Z" />
        <path d="M-57 17C200-42 328 160 195 291S-87 475 87 735" />
        <path d="M-75 40C181-22 306 170 174 299S-103 489 65 744" />
        <path d="M-93 65C161 0 282 180 151 310S-120 505 43 754" />
        <path d="M-111 90C140 23 258 192 128 322S-136 522 20 766" />
        <path d="M-129 115C120 46 234 205 105 335S-153 538-3 778" />
      </svg>
      <svg className="auth-backdrop__ribbon auth-backdrop__ribbon--right" viewBox="0 0 370 720" fill="none" focusable="false">
        <path className="auth-backdrop__wash" d="M405 12C128 88 106 260 248 369S436 557 225 729H405Z" />
        <path d="M414-4C132 75 94 255 239 372S422 555 211 735" />
        <path d="M435 16C154 94 117 263 260 378S444 565 235 750" />
        <path d="M456 36C176 113 140 271 281 384S466 575 259 765" />
        <path d="M477 56C198 132 163 279 302 390S488 585 283 780" />
        <path d="M498 76C220 151 186 287 323 396S510 595 307 795" />
      </svg>
      <svg className="auth-backdrop__keepsake auth-backdrop__keepsake--left" viewBox="0 0 120 120" fill="none" focusable="false">
        {friends ? (
          <>
            <path d="m21 78 29-49 18 37 32-24-21 52-58-16Z" />
            <path d="m21 78 47-12 11 28M50 29l18 37 32-24" />
            <path className="auth-backdrop__dashed" d="M13 98c18 15 58 11 77-2" />
          </>
        ) : (
          <>
            <rect x="23" y="30" width="76" height="57" rx="9" transform="rotate(-12 23 30)" />
            <path d="m26 36 43 22 29-37M34 82l22-28m43 14L83 48" />
            <path className="auth-backdrop__solid" d="M55 41c-7-7-14 2-8 7l11 8 7-12c4-8-7-12-10-3Z" />
          </>
        )}
      </svg>
      <svg className="auth-backdrop__keepsake auth-backdrop__keepsake--right" viewBox="0 0 120 120" fill="none" focusable="false">
        <path d="m28 72 65-38-21 59-14-24-30 3Z" />
        <path d="m58 69 35-35M58 69l-6 20 20 4" />
        <path className="auth-backdrop__dashed" d="M19 86c-23 12 7 34 25 17" />
        <path className="auth-backdrop__spark" d="M24 26v14m-7-7h14M94 99v8m-4-4h8" />
      </svg>
      <svg className="auth-backdrop__tides" viewBox="0 0 1440 210" preserveAspectRatio="none" fill="none" focusable="false">
        <path className="auth-backdrop__wash" d="M0 88C240-30 386 200 695 115S1163 18 1440 95V210H0Z" />
        <path d="M-20 100C220-18 386 212 695 127S1163 30 1460 107" />
        <path d="M-20 122C220 4 386 234 695 149S1163 52 1460 129" />
        <path d="M-20 144C220 26 386 256 695 171S1163 74 1460 151" />
      </svg>
    </div>
  );
}
