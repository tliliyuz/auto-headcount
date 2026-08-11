import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "职位激活台",
    description: "零推荐职位激活系统内部运营后台",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "职位激活台",
      description: "让沉睡的职位，重新流动起来",
      images: [{ url: `${origin}/og-dashboard.png`, width: 1731, height: 909, alt: "职位激活台完整运营后台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "职位激活台",
      description: "让沉睡的职位，重新流动起来",
      images: [`${origin}/og-dashboard.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
