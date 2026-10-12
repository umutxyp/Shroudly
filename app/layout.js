import './globals.css'
import { LanguageProvider } from '@/contexts/LanguageContext'

export const metadata = {
  title: 'Shroudly - Unseen. Unstoppable.',
  description: 'Advanced DPI Bypass Technology by Codeshare Technology Ltd',
}

/* Everything this window needs is already inside it: the interface talks to the
 * app over the preload bridge, never over the network. Saying so explicitly
 * means that even if something were injected into the page, it would have
 * nowhere to send what it found — and the log it could read contains the sites
 * the user visited. Styles and the hydration script are inline by the
 * framework's design, so those stay permitted. */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export default function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body>
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </body>
    </html>
  )
}
