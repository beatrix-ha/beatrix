import {
  createEvalRuntime,
  failureGrader,
  gradeContentViaPrompt,
  gradeViaSearchForContent,
  runScenario,
} from '../eval-framework'
import { LargeLanguageProvider, createBuiltinServers } from '../llm'

// Basic service listing evaluation
export async function* listServicesEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()

  yield await runScenario(
    llm,
    'What services are available for my living room lights?',
    createBuiltinServers(runtime, null),
    'List services for entity',
    [
      failureGrader(),
      gradeViaSearchForContent('On', 'Off'),
      gradeContentViaPrompt(
        'Did the assistant correctly list the services available for light entities, including "Turn on" and "Turn off"? Does it list that some lights have support for colors?'
      ),
    ]
  )
}

// Basic light control evaluation
export async function* lightControlEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()

  yield await runScenario(
    llm,
    'Turn on the kitchen chandelier light',
    createBuiltinServers(runtime, null),
    'Basic light control',
    [
      failureGrader(),
      gradeContentViaPrompt(
        'Did the assistant correctly identify kitchen lights and turn them on using the appropriate service call to kitchen_dining_room_chandelier?'
      ),
    ]
  )
}

// Advanced light control with brightness
export async function* lightBrightnessEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Set the brightness of the living room lights to 50%',
    createBuiltinServers(runtime, null),
    'Light brightness control',
    [
      failureGrader(),
      gradeViaSearchForContent('light.turn_on', 'brightness'),
      gradeContentViaPrompt(
        'Did the assistant correctly set the brightness of the living room lights to approximately 50% (around 127 on a 0-255 scale)?'
      ),
    ]
  )
}

// Light color control
export async function* lightColorEval(llmFactory: () => LargeLanguageProvider) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Make the bedroom lights blue',
    createBuiltinServers(runtime, null),
    'Light color control',
    [
      failureGrader(),
      gradeViaSearchForContent('light.turn_on', 'rgb_color', 'blue'),
      gradeContentViaPrompt(
        'Did the assistant correctly set the color of the bedroom lights to blue using the appropriate service data?'
      ),
    ]
  )
}

// Multiple entity control
export async function* multipleEntityControlEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Turn off all the lights in the living room and kitchen',
    createBuiltinServers(runtime, null),
    'Multiple entity control',
    [
      failureGrader(),
      gradeViaSearchForContent('light.turn_off', 'living room', 'kitchen'),
      gradeContentViaPrompt(
        'Did the assistant correctly identify and turn off all lights in both the living room and kitchen?'
      ),
    ]
  )
}

// Media player control
export async function* mediaPlayerControlEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Pause the TV in the living room',
    createBuiltinServers(runtime, null),
    'Media player control',
    [
      failureGrader(),
      gradeViaSearchForContent('media_player.media_pause', 'living room', 'TV'),
      gradeContentViaPrompt(
        'Did the assistant correctly pause the TV using the appropriate media_player service?'
      ),
    ]
  )
}

// Climate control with temperature
export async function* climateControlTemperatureEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Set the thermostat in the bedroom to 72 degrees',
    createBuiltinServers(runtime, null),
    'Climate temperature control',
    [
      failureGrader(),
      gradeViaSearchForContent('climate.set_temperature', 'bedroom', '72'),
      gradeContentViaPrompt(
        'Did the assistant correctly set the bedroom thermostat to 72 degrees using the climate.set_temperature service?'
      ),
    ]
  )
}

// Climate control with mode
export async function* climateControlModeEval(
  llmFactory: () => LargeLanguageProvider
) {
  const runtime = await createEvalRuntime(llmFactory)
  const llm = llmFactory()
  yield await runScenario(
    llm,
    'Switch the living room thermostat to heat mode',
    createBuiltinServers(runtime, null),
    'Climate mode control',
    [
      failureGrader(),
      gradeViaSearchForContent('climate.set_hvac_mode', 'living room', 'heat'),
      gradeContentViaPrompt(
        'Did the assistant correctly set the living room thermostat to heat mode using the climate.set_hvac_mode service?'
      ),
    ]
  )
}

// Cover control
/* XXX: Great eval but it's not in the data
export async function* coverControlEval(llm: LargeLanguageProvider) {
  yield await runScenario(
    llm,
    'Close all the blinds in the house',
    createDefaultMockedTools(llm),
    'Cover control',
    [
      failureGrader(),
      gradeViaSearchForContent('cover.close_cover'),
      gradeContentViaPrompt(
        'Did the assistant correctly identify all cover entities and close them using the cover.close_cover service?'
      ),
    ]
  )
}
  */

// TODO: Add expected results for each eval as they might vary based on mock data
