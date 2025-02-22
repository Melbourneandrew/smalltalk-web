import {
    AutoTokenizer,
    AutoModelForCausalLM,
    TextStreamer,
    InterruptableStoppingCriteria
} from '@huggingface/transformers';

let modelInstance = null;
let tokenizerInstance = null;
let pastKeyValuesCache = null;
const stoppingCriteria = new InterruptableStoppingCriteria();

export async function getInstance(model = null, dtype = null, progress_callback = undefined) {
    // Return existing instances if no parameters provided
    if (model === null && dtype === null) {
        if (!modelInstance || !tokenizerInstance) {
            throw new Error('No model instance exists. Please initialize with model and dtype parameters first.');
        }
        return { model: modelInstance, tokenizer: tokenizerInstance };
    }

    if (!model || !dtype) {
        throw new Error('Both model and dtype parameters are required for initialization');
    }

    tokenizerInstance = await AutoTokenizer.from_pretrained(model, {
        progress_callback
    });
    modelInstance = await AutoModelForCausalLM.from_pretrained(model, {
        dtype: dtype,
        device: 'webgpu',
        progress_callback,
    });

    return { model: modelInstance, tokenizer: tokenizerInstance };
}

function sendError(error, context = '') {
    const errorMessage = context ? `${context}: ${error.message}` : error.message;
    console.error(errorMessage, error);
    self.postMessage({
        status: 'error',
        error: errorMessage,
        stack: error.stack
    });
}

export async function load(model, dtype, progress_callback = undefined) {
    if (!model || !dtype) {
        throw new Error('Both model and dtype parameters are required');
    }
    try {
        self.postMessage({
            status: "loading",
            data: "Loading model..."
        });

        const { model: modelInstance, tokenizer } = await getInstance(model, dtype, progress_callback);

        // Run model with dummy input to compile shaders
        // const inputs = tokenizer.apply_chat_template([{ role: "user", content: "Hello" }], {
        //     add_generation_prompt: true,
        //     return_dict: true,
        // });

        // await modelInstance.generate({
        //     ...inputs,
        //     max_new_tokens: 1
        // });

        self.postMessage({ status: "ready" });
        return { model: modelInstance, tokenizer };
    } catch (error) {
        sendError(error, 'Error occurred while loading model');
        throw error;
    }
}

export function reset() {
    if (modelInstance) {
        modelInstance.dispose();
    }
    modelInstance = null;
    tokenizerInstance = null;
    pastKeyValuesCache = null;
    stoppingCriteria.reset();
}

export async function generate(messages, params = {}) {
    try {
        const { model, tokenizer } = await getInstance();
        if (!model || !tokenizer) {
            throw new Error('Failed to get model or tokenizer instance');
        }

        const inputs = tokenizer.apply_chat_template(messages, {
            add_generation_prompt: true,
            return_dict: true,
        });

        console.log("Generation params: ", params);

        const generationParams = params;

        let startTime;
        let numTokens = 0;
        let tps;

        const token_callback_function = () => {
            startTime ??= performance.now();
            if (numTokens++ > 0) {
                tps = (numTokens / (performance.now() - startTime)) * 1000;
            }
        };

        const callback_function = (output) => {
            self.postMessage({
                status: 'update',
                output: output,
                tps,
                numTokens
            });
        };

        const streamer = new TextStreamer(tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function,
            token_callback_function,
        });

        self.postMessage({ status: 'start' });

        const { past_key_values, sequences } = await model.generate({
            ...inputs,
            streamer,
            stopping_criteria: stoppingCriteria,
            return_dict_in_generate: true,
            ...generationParams
        });

        pastKeyValuesCache = past_key_values;

        const decoded = tokenizer.batch_decode(sequences, {
            skip_special_tokens: true,
        });

        return { decoded, tps, numTokens };
    } catch (error) {
        sendError(error, 'Error during generation');
        throw error;
    }
}

export function handleProgress(progress) {
    self.postMessage(progress);
}

// Main worker message handler
self.addEventListener('message', async (event) => {
    try {
        if (!event.data) {
            throw new Error('No event data received');
        }

        const { type, data } = event.data;

        switch (type) {
            case 'init':
                const { model, dtype } = data || {};
                if (!model || !dtype) {
                    throw new Error('Both model and dtype parameters are required for initialization');
                }
                console.log("Initializing model with: ", model, dtype);
                await load(model, dtype, handleProgress);
                break;

            case 'generate':
                stoppingCriteria.reset();
                try {
                    const { messages, params } = data;
                    console.log("Generating response for messages: ", messages);
                    const { decoded, tps, numTokens } = await generate(messages, params);
                    self.postMessage({
                        status: 'complete',
                        output: decoded,
                        tps,
                        numTokens
                    });
                } catch (error) {
                    console.error('Generation error:', error);
                    throw error;
                }
                break;

            case 'interrupt':
                stoppingCriteria.interrupt();
                break;

            case 'reset':
                reset();
                break;
        }

    } catch (error) {
        sendError(error, 'Worker error');
    }
});
