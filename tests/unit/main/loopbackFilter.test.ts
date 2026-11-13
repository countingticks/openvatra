// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { allowLoopbackRequest } from '../../../src/main/loopbackFilter'

describe('allowLoopbackRequest', () => {
  const prod = 'file:///C:/Program%20Files/OpenVatra/resources/app.asar/out/renderer/index.html'
  const dev = 'http://localhost:5173/'

  it("allows core's port on 127.0.0.1", () => {
    expect(allowLoopbackRequest('http://127.0.0.1:53121/api/version', 53121, prod)).toBe(true)
  })

  it.each(['http://127.0.0.1:8081/v1/models', 'http://localhost:53121/api/version'])(
    "refuses %s, which is not core's port on 127.0.0.1",
    (url) => expect(allowLoopbackRequest(url, 53121, prod)).toBe(false)
  )

  it('refuses 127.0.0.1 while core has no port', () => {
    expect(allowLoopbackRequest('http://127.0.0.1:53121/api/version', undefined, prod)).toBe(false)
  })

  it('allows the dev server origin only when the app is served from it', () => {
    expect(allowLoopbackRequest('http://localhost:5173/@vite/client', 53121, dev)).toBe(true)
    expect(allowLoopbackRequest('http://localhost:5173/@vite/client', 53121, prod)).toBe(false)
  })
})
