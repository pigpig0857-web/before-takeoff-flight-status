import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import './typography.css';
import './flight-cards.css';
import './round-trip.css';
const queryFont = localFont({
  src: '../../public/fonts/FlightQuerySans.woff2',
  variable: '--font-query-sans',
  weight: '100 900',
  display: 'swap',
  adjustFontFallback: false,
});
export const metadata: Metadata = {
  title: '起飛之前｜桃園與高雄航班查詢與出發指引',
  description:
    '查詢桃園與高雄出發航班、起飛時段與出發指引。第一次出國，也能清楚掌握下一步。',
  robots: { index: true, follow: true },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant" className={queryFont.variable}>
      <body>
        <a className="skip-link" href="#flight-search">
          跳至航班查詢
        </a>
        {children}
      </body>
    </html>
  );
}
