import './globals.css'
import { LanguageProvider } from '@/contexts/LanguageContext'

export const metadata = {
  title: 'Shroudly - Unseen. Unstoppable.',
  description: 'Advanced DPI Bypass Technology by Codeshare Technology Ltd',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </body>
    </html>
  )
}
