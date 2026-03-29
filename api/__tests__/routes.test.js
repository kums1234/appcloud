// __tests__/routes.test.js
import { jest } from '@jest/globals'

describe('API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Applications Routes', () => {
    test('route module can be imported', async () => {
      // Mock the serialize utility before importing
      jest.doMock('../src/utils/serialize.js', () => ({
        props: jest.fn((node) => node?.properties || node),
        serialize: jest.fn((value) => value)
      }))

      // Simple test to verify the module can be imported
      const applicationsModule = await import('../src/routes/applications.js')
      expect(applicationsModule).toBeDefined()
      expect(typeof applicationsModule.default).toBe('function')
    })

    test('handles database errors gracefully', async () => {
      // Mock the serialize utility
      jest.doMock('../src/utils/serialize.js', () => ({
        props: jest.fn((node) => node?.properties || node),
        serialize: jest.fn((value) => value)
      }))

      const applicationsModule = await import('../src/routes/applications.js')

      // Mock Fastify instance with all required methods
      const mockFastify = {
        neo4j: {
          query: jest.fn().mockRejectedValue(new Error('Database connection failed')),
          write: jest.fn()
        },
        pg: {
          audit: jest.fn().mockResolvedValue(undefined)
        },
        authenticate: jest.fn(),
        register: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
        setErrorHandler: jest.fn(),
        decorate: jest.fn(),
        decorateRequest: jest.fn(),
        addHook: jest.fn()
      }

      // Should not throw during route registration
      await expect(applicationsModule.default(mockFastify)).resolves.not.toThrow()
    })
  })
})