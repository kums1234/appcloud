import './globals.css'

export const metadata = {
  title: 'AppCloud — Infrastructure Graph',
  description: 'Visualise and manage your infrastructure graph',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
