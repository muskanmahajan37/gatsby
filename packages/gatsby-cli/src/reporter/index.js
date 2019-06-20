// @flow
const util = require(`util`)
const { stripIndent } = require(`common-tags`)
const chalk = require(`chalk`)
const { trackError } = require(`gatsby-telemetry`)
const tracer = require(`opentracing`).globalTracer()
const { getErrorFormatter } = require(`./errors`)
const reporterInstance = require(`./reporters`)
const stackTrace = require(`stack-trace`)
const { errorMap, defaultError } = require(`../util/error-map`)
const { errorSchema } = require(`../util/error-schema`)
const Joi = require(`joi`)
const errorFormatter = getErrorFormatter()
import { get } from "lodash"

import type { ActivityTracker, ActivityArgs, Reporter } from "./types"

// Merge partial error details with information from the errorMap
// Validate the constructed object against an error schema
const createRichError = params => {
  const { details } = params
  const result = (details.id && errorMap[details.id]) || defaultError

  // merge details and lookedup error
  const richError = {
    ...details,
    ...result,
    text: get(details, `text`) || result.text(details.context),
    stack: details.error ? stackTrace.parse(details.error) : [],
  }

  // validate against schema
  const { error } = Joi.validate(richError, errorSchema)
  if (error !== null) {
    console.log(`Failed to validate error`, error)
    process.exit(1)
  }

  return richError
}

/**
 * Reporter module.
 * @module reporter
 */
const reporter: Reporter = {
  /**
   * Strip initial indentation template function.
   */
  stripIndent,
  format: chalk,
  /**
   * Toggle verbosity.
   * @param {boolean} [isVerbose=true]
   */
  setVerbose: (isVerbose = true) => reporterInstance.setVerbose(isVerbose),
  /**
   * Turn off colors in error output.
   * @param {boolean} [isNoColor=false]
   */
  setNoColor(isNoColor = false) {
    reporterInstance.setColors(isNoColor)

    if (isNoColor) {
      errorFormatter.withoutColors()
    }
  },
  /**
   * Log arguments and exit process with status 1.
   * @param {*} args
   */
  panic(...args) {
    this.error(...args)
    trackError(`GENERAL_PANIC`, { error: args })
    process.exit(1)
  },

  panicOnBuild(...args) {
    this.error(...args)
    trackError(`BUILD_PANIC`, { error: args })
    if (process.env.gatsby_executing_command === `build`) {
      process.exit(1)
    }
  },

  error(errorMeta, error) {
    let details = {}
    // Three paths to retain backcompat
    // string and Error
    if (arguments.length === 2) {
      details.error = error
      details.text = errorMeta
      // just an Error
    } else if (arguments.length === 1 && errorMeta instanceof Error) {
      details.error = errorMeta
      details.text = error.message
      // object with partial error info
    } else if (arguments.length === 1 && typeof errorMeta === `object`) {
      details = Object.assign({}, errorMeta)
    } else if (arguments.length === 1 && typeof errorMeta === `string`) {
      details.text = errorMeta
    }

    const richError = createRichError({ details })

    if (richError) reporterInstance.error(richError)

    // TODO: remove this once Error component can render this info
    // log formatted stacktrace
    if (richError.error) this.log(errorFormatter.render(richError.error))
  },

  /**
   * Set prefix on uptime.
   * @param {string} prefix - A string to prefix uptime with.
   */
  uptime(prefix) {
    this.verbose(`${prefix}: ${(process.uptime() * 1000).toFixed(3)}ms`)
  },

  success: reporterInstance.success,
  verbose: reporterInstance.verbose,
  info: reporterInstance.info,
  warn: reporterInstance.warn,
  log: reporterInstance.log,

  /**
   * Time an activity.
   * @param {string} name - Name of activity.
   * @param {ActivityArgs} activityArgs - optional object with tracer parentSpan
   * @returns {ActivityTracker} The activity tracker.
   */
  activityTimer(
    name: string,
    activityArgs: ActivityArgs = {}
  ): ActivityTracker {
    const { parentSpan } = activityArgs
    const spanArgs = parentSpan ? { childOf: parentSpan } : {}
    const span = tracer.startSpan(name, spanArgs)

    const activity = reporterInstance.createActivity({
      type: `spinner`,
      id: name,
      status: ``,
    })

    return {
      start() {
        activity.update({
          startTime: process.hrtime(),
        })
      },
      setStatus(status) {
        activity.update({
          status: status,
        })
      },
      end() {
        span.finish()
        activity.done()
      },
      span,
    }
  },

  /**
   * Create a progress bar for an activity
   * @param {string} name - Name of activity.
   * @param {number} total - Total items to be processed.
   * @param {number} start - Start count to show.
   * @param {ActivityArgs} activityArgs - optional object with tracer parentSpan
   * @returns {ActivityTracker} The activity tracker.
   */
  createProgress(
    name: string,
    total,
    start = 0,
    activityArgs: ActivityArgs = {}
  ): ActivityTracker {
    const { parentSpan } = activityArgs
    const spanArgs = parentSpan ? { childOf: parentSpan } : {}
    const span = tracer.startSpan(name, spanArgs)

    let hasStarted = false
    let current = start
    const activity = reporterInstance.createActivity({
      type: `progress`,
      id: name,
      current,
      total,
    })

    return {
      start() {
        if (hasStarted) {
          return
        }

        hasStarted = true
        activity.update({
          startTime: process.hrtime(),
        })
      },
      setStatus(status) {
        activity.update({
          status: status,
        })
      },
      tick() {
        activity.update({
          current: ++current,
        })
      },
      done() {
        span.finish()
        activity.done()
      },
      set total(value) {
        total = value
        activity.update({
          total: value,
        })
      },
      span,
    }
  },
  // Make private as we'll probably remove this in a future refactor.
  _setStage(stage) {
    if (reporterInstance.setStage) {
      reporterInstance.setStage(stage)
    }
  },
}

console.log = (...args) => reporter.log(util.format(...args))
console.warn = (...args) => reporter.warn(util.format(...args))
console.info = (...args) => reporter.info(util.format(...args))
console.error = (...args) => reporter.error(util.format(...args))

module.exports = reporter
