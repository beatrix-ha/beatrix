import { describe, expect, it, jest } from 'bun:test'
import { Connection } from 'home-assistant-js-websocket'

import { LiveHomeAssistantApi } from './ha-ws-api'

describe('LiveHomeAssistantApi', () => {
  describe('fetchServices method', () => {
    it('can fetch the services list', async () => {
      // Create a mock response for the services
      const mockServices = {
        notify: {
          mobile_app: {
            name: 'mobile_app',
            description: 'Sends a notification to the device',
            fields: {
              message: {
                description: 'Message body of the notification',
                example: 'The garage door has been open for 10 minutes.',
              },
              title: {
                description: 'Title for the notification',
                example: 'Your Garage Door',
              },
            },
          },
        },
        light: {
          turn_on: {
            name: 'Turn on',
            description: 'Turn on light',
            fields: {},
          },
        },
      }

      // Create mock connection
      const mockSendMessagePromise = jest.fn().mockResolvedValue(mockServices)
      const mockConnection = {
        sendMessagePromise: mockSendMessagePromise,
      } as unknown as Connection

      // Create the API instance with the mock connection
      const api = new LiveHomeAssistantApi(mockConnection)

      // Call the method
      const svcs = await api.fetchServices()

      // Verify the method sent the correct message
      expect(mockSendMessagePromise).toHaveBeenCalledWith({
        type: 'get_services',
      })

      // Verify the result
      expect(svcs).toBeDefined()
      expect(svcs).toEqual(mockServices)
      expect(svcs.notify).toBeDefined()
    })
  })

  describe('callService method', () => {
    it('should correctly format and send service call message', async () => {
      // Create mock connection
      const mockSendMessagePromise = jest
        .fn()
        .mockResolvedValue({ result: 'success' })
      const mockConnection = {
        sendMessagePromise: mockSendMessagePromise,
      } as unknown as Connection

      // Create the API instance with the mock connection
      const api = new LiveHomeAssistantApi(mockConnection)

      // Call the method
      await api.callService({
        domain: 'light',
        service: 'turn_on',
        service_data: {
          color_name: 'beige',
          brightness: '101',
        },
        target: {
          entity_id: 'light.kitchen',
        },
        return_response: true,
      })

      // Verify correct message was sent
      expect(mockSendMessagePromise).toHaveBeenCalledWith({
        type: 'call_service',
        domain: 'light',
        service: 'turn_on',
        service_data: {
          color_name: 'beige',
          brightness: '101',
        },
        target: {
          entity_id: 'light.kitchen',
        },
        return_response: true,
      })
    })

    it('should validate entity ID domain in test mode', async () => {
      const mockConnection = {
        sendMessagePromise: jest.fn(),
      } as unknown as Connection

      // Create the API instance with test mode enabled
      const api = new LiveHomeAssistantApi(mockConnection, true)

      // Valid entity ID that starts with the domain
      const result = await api.callService({
        domain: 'light',
        service: 'turn_on',
        target: {
          entity_id: 'light.kitchen',
        },
      })

      // Should pass validation and return null
      expect(result).toBeNull()
      // Should not call sendMessagePromise in test mode
      expect(mockConnection.sendMessagePromise).not.toHaveBeenCalled()
    })

    it('should throw error for invalid entity ID in test mode', async () => {
      const mockConnection = {
        sendMessagePromise: jest.fn(),
      } as unknown as Connection

      // Create the API instance with test mode enabled
      const api = new LiveHomeAssistantApi(mockConnection, true)

      // Entity ID that doesn't match the domain
      expect(
        api.callService({
          domain: 'light',
          service: 'turn_on',
          target: {
            entity_id: 'switch.kitchen',
          },
        })
      ).rejects.toThrow("Entity ID switch.kitchen doesn't match domain light")

      // Should not call sendMessagePromise when validation fails
      expect(mockConnection.sendMessagePromise).not.toHaveBeenCalled()
    })

    it('should handle array of entity IDs in test mode', async () => {
      const mockConnection = {
        sendMessagePromise: jest.fn(),
      } as unknown as Connection

      // Create the API instance with test mode enabled
      const api = new LiveHomeAssistantApi(mockConnection, true)

      // Valid array of entity IDs that all start with the domain
      const result = await api.callService({
        domain: 'light',
        service: 'turn_on',
        target: {
          entity_id: ['light.kitchen', 'light.living_room'],
        },
      })

      // Should pass validation and return null
      expect(result).toBeNull()
      // Should not call sendMessagePromise in test mode
      expect(mockConnection.sendMessagePromise).not.toHaveBeenCalled()
    })

    it('should throw error for mixed valid/invalid entity IDs in test mode', async () => {
      const mockConnection = {
        sendMessagePromise: jest.fn(),
      } as unknown as Connection

      // Create the API instance with test mode enabled
      const api = new LiveHomeAssistantApi(mockConnection, true)

      // Array with one valid and one invalid entity ID
      expect(
        api.callService({
          domain: 'light',
          service: 'turn_on',
          target: {
            entity_id: ['light.kitchen', 'switch.porch'],
          },
        })
      ).rejects.toThrow("Entity ID switch.porch doesn't match domain light")

      // Should not call sendMessagePromise when validation fails
      expect(mockConnection.sendMessagePromise).not.toHaveBeenCalled()
    })
  })
})
