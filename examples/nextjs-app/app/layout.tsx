import "./globals.css";

export const metadata = {
  title: "Next.js with Zcash sign-in",
  description: "The Next.js authentication example with the imani Zcash login in place of GitHub",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
