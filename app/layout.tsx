import './globals.css';
import type { Metadata } from 'next';
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import { makeBrand } from '@/lib/brand';
import { loadEventState } from '@/lib/server/event';
import { BrandProvider } from '@/components/brand-provider';

const space = Space_Grotesk({ subsets: ['latin'], variable: '--font-space' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '500', '600'] });

// Without this the title is baked in at build time, so renaming the event in
// System Settings would not reach the browser tab until the next deploy.
export const dynamic = 'force-dynamic';

/**
 * The browser-tab title follows the event name set in System Settings. If the
 * database is unreachable the page must still render, so this falls back to a
 * neutral title rather than throwing.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await currentBrand();
  return { title: brand.name + ' Control Center', description: brand.organization + ' event control system' };
}

/** The brand the server knows, so no screen paints the wrong event name first. */
async function currentBrand() {
  try {
    const state = await loadEventState();
    return makeBrand(state.event_name, state.organization);
  } catch {
    return makeBrand();
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const brand = await currentBrand();
  return (
    <html lang="en">
      <body className={`${space.variable} ${mono.variable}`}>
        <BrandProvider brand={brand}>{children}</BrandProvider>
      </body>
    </html>
  );
}
