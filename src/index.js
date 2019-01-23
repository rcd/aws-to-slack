"use strict";

const _ = require("lodash"),
	Slack = require("./slack"),
	parsers = _.map([
		// Ordered list of parsers:
		"cloudwatch",
		"codecommit/pullrequest",
		"codecommit/repository",
		"autoscaling",
		"aws-health",
		"beanstalk",
		"cloudformation",
		"codebuild",
		"codedeployCloudWatch",
		"codedeploySns",
		"codepipelineSns",
		"codepipeline-approval",
		"codepipelineCloudWatch",
		"guardduty",
		"inspector",
		"rds",
		"ses-received",
		// Last attempt to parse, will match any:
		"generic",
	], name => [name, require(`./parsers/${name}`)]);

class LambdaHandler {

	constructor() {
		// clone so can be tested
		this.parsers = new Array(parsers.length);
		this.parserNames = new Array(parsers.length);
		_.each(parsers, (o, i) => {
			this.parserNames[i] = o[0];
			this.parsers[i] = o[1];
		});
		this.lastParser = null;
	}

	/**
	 * Run .parse() on each handler in-sequence.
	 *
	 * @param {{}} event Single-event object
	 * @returns {Promise<?{}>} Resulting message or null if no match found
	 */
	async processEvent(event) {
		// Execute all parsers and use the first successful result
		for (const i in this.parsers) {
			const parserName = this.parserNames[i];
			this.lastParser = parserName;
			try {
				const parser = new this.parsers[i]();
				const message = await parser.parse(event);
				if (message) {
					// Truthy but empty message will stop execution
					if (message === true || _.isEmpty(message)) {
						return null;// never send empty message
					}

					// Set return value as properties of object
					parser.slackMessage = message;
					parser.name = parserName;
					return parser;
				}
			}
			catch (e) {
				console.error(`Error parsing event [parser:${parserName}]:`, e);
			}
		}
	}

	/**
	 * Lambda event handler.
	 *
	 * @param {{}} event Event object received via Lambda payload
	 * @param {{}} context Lambda execution context
	 * @param {Function} callback Lambda completion callback
	 * @returns {Promise<void>} No return value
	 */
	static async handler(event, context, callback) {
		context.callbackWaitsForEmptyEventLoop = false;
		console.log("Incoming Message:", JSON.stringify(event, null, 2));

		if (_.isString(event)) {
			try {
				event = JSON.parse(event);
			}
			catch (err) {
				console.error(`Error parsing event JSON (continuing...): ${event}`);
			}
		}

		try {
			const handler = new LambdaHandler();

			if (_.isArray(event.Records) && event.Records.length > 1) {
				// If SNS contains >1 record, process each independently for they may be different types
				for (const i in event.Records) {
					// Copy single record into event
					const singleRecordEvent = _.assign({}, event, {
						Records: [ event.Records[i] ],
					});

					const parser = await handler.processEvent(singleRecordEvent);
					if (parser) {
						const message = parser.slackMessage;
						console.log(`Sending Slack message from SNS-Parser[${parser.name}]:`, JSON.stringify(message, null, 2));
						await Slack.postMessage(message);
					}
					else if (handler.lastParser) {
						console.error(`Parser force-ignoring SNS event[${i}]: ${handler.lastParser}`);
					}
					else {
						console.log(`No parser matched SNS event[${i}]`);
					}
				}
			}
			else {
				const parser = await handler.processEvent(event);
				if (parser) {
					const message = parser.slackMessage;
					console.log(`Sending Slack message from Parser[${parser.name}]:`, JSON.stringify(message, null, 2));
					await Slack.postMessage(message);
				}
				else if (handler.lastParser) {
					console.error(`Parser[${handler.parserName}] is force-ignoring event`);
				}
				else {
					console.log("No parser matched event");
				}
			}

			callback();
		}
		catch (e) {
			console.log("ERROR:", e);
			callback(e);
		}
	}
}

module.exports = LambdaHandler;
