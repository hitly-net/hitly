import { NextResponse } from 'next/server'

function association() {
  const appId = process.env.HITLY_MOBILE_APP_ID?.trim()
  const teamId = process.env.HITLY_IOS_TEAM_ID?.trim()
  if (!appId || !teamId) return null
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${teamId}.${appId}`,
          paths: ['/inbox/*'],
        },
      ],
    },
  }
}

export async function GET() {
  const body = association()
  if (!body) return new NextResponse(null, { status: 404 })
  return NextResponse.json(body, {
    headers: { 'content-type': 'application/json' },
  })
}
