'use client';

import { createContext, useContext } from 'react';
import { makeBrand, type Brand } from '@/lib/brand';

/**
 * The event name the server already knew when it rendered the page.
 *
 * Without it every screen would paint the built-in fallback for a moment
 * before its first query returned — a renamed event would flash "YHACK'26"
 * on the projector at every reload.
 */
const BrandContext = createContext<Brand>(makeBrand());

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useInitialBrand(): Brand {
  return useContext(BrandContext);
}
