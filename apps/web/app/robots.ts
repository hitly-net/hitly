import { buildRobots } from '@/lib/site'

export const revalidate = false

export default function robots() {
  return buildRobots()
}
