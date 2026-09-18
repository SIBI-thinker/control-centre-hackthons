'use client';

import type { Brand } from '@/lib/brand';

/**
 * The logo tile plus event name used on every screen. Kept in one place so a
 * rename in System Settings can never reach some screens and miss others.
 */
export function BrandLockup({
  brand,
  subtitle,
  className = 'brand-lockup',
  markClassName = 'brand-mark',
}: {
  brand: Brand;
  subtitle?: React.ReactNode;
  className?: string;
  markClassName?: string;
}) {
  return (
    <div className={className}>
      <div className={markClassName}>{brand.mark}</div>
      <div>
        <strong>
          {brand.main}
          {brand.accent && <span>{brand.accent}</span>}
        </strong>
        {subtitle !== undefined && <small>{subtitle}</small>}
      </div>
    </div>
  );
}
