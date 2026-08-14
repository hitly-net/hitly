import { NextResponse } from 'next/server'

function links() {
  const packageName = process.env.HITLY_MOBILE_APP_ID?.trim()
  const sha256 = process.env.HITLY_ANDROID_SHA256?.trim()
  if (!packageName || !sha256) return null
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [sha256],
      },
    },
  ]
}

export async function GET() {
  const body = links()
  if (!body) return new NextResponse(null, { status: 404 })
  return NextResponse.json(body)
}
