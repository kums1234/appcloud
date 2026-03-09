import './globals.css'
import { Providers } from '@/components/providers'

export const metadata = {
  title: 'AppCloud — Infrastructure Graph',
  description: 'Visualise and manage your infrastructure graph',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  )
}
