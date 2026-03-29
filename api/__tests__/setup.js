// __tests__/setup.js
import { jest } from '@jest/globals'

// Jest setup file for unit tests

// Mock external dependencies
jest.mock('neo4j-driver', () => ({
  driver: jest.fn(() => ({
    session: jest.fn(() => ({
      run: jest.fn(),
      close: jest.fn()
    })),
    close: jest.fn()
  })),
  auth: {
    basic: jest.fn()
  }
}))

jest.mock('pg', () => ({
  Client: jest.fn(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn()
  }))
}))

// Mock environment variables for tests
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests'