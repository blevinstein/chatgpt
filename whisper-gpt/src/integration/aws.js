import AWS from 'aws-sdk';
import dotenv from 'dotenv';

dotenv.config();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const dynamo = new AWS.DynamoDB();
const polly = new AWS.Polly();
const s3 = new AWS.S3();

export const LOGS_BUCKET = 'whisper-gpt-logs';
export const IMAGE_BUCKET = 'whisper-gpt-generated';
// TODO: Add environment parameter here
export const AGENTS_DB = 'whisper-gpt-agents-db-dev';

export function uploadFileToS3(bucketName, key, data, contentType) {
    const params = {
        Bucket: bucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
    };

    return new Promise((resolve, reject) => {
        s3.upload(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

export function downloadFileFromS3(bucketName, key) {
    const params = {
        Bucket: bucketName,
        Key: key,
    };

    return new Promise((resolve, reject) => {
        s3.getObject(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

export async function listFilesInS3(bucketName) {
    const params = {
        Bucket: bucketName,
    };

    const results = [];
    let continuationToken;
    let listResponse;
    do {
        listResponse = await new Promise((resolve, reject) => {
          s3.listObjectsV2({ ...params, ContinuationToken: continuationToken }, (err, data) => {
              if (err) {
                  reject(err);
              } else {
                  resolve(data);
              }
          });
        });
        results.push(...listResponse.Contents);
        continuationToken = listResponse.NextContinuationToken;
    } while (listResponse.IsTruncated);

    return results;
}

export function getVoices() {
    return new Promise((resolve, reject) => {
        polly.describeVoices({}, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data.Voices);
            }
        });
    });
}

const DEFAULT_VOICE_ID = 'Matthew';
export function synthesizeSpeech(text, language, voice) {
    const params = {
        OutputFormat: "mp3",
        Text: language ? `<lang xml:lang="${language}">${text}</lang>` : text,
        TextType: 'ssml',
        VoiceId: voice || DEFAULT_VOICE_ID,
        Engine: 'neural',
    };

    return new Promise((resolve, reject) => {
        polly.synthesizeSpeech(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

function addType(data) {
    if (typeof data === 'number') {
        return { N: data };
    } else if (typeof data === 'string') {
        return { S: data };
    } else if (typeof data === 'boolean') {
        return { BOOL: data };
    } else if (Array.isArray(data) && data.length && data.every(el => typeof el === 'number')) {
        return { NS: data };
    } else if (Array.isArray(data) && data.length && data.every(el => typeof el === 'string')) {
        return { SS: data };
    } else if (Array.isArray(data)) {
        return { L: data.map(d => addType(d)) };
    } else if (data instanceof Map) {
      return { M: Object.fromEntries(Array.from(data.entries())
          .map(([key, value]) => [key, addType(value)])) }
    } else if (typeof data === 'object') {
      return { M: Object.fromEntries(Object.entries(data)
          .map(([key, value]) => [key, addType(value)])) }
    }
    throw new Error(`Unexpected input: ${data}`);
}

export function putAgent(data) {
  const { id, options, systemPrompt, messages = [], state = {} } = data;
  if (!id) throw new Error('Missing id!');
  return new Promise((resolve, reject) => {
      dynamo.putItem({
          Item: addType({ id, systemPrompt, options, messages, state }).M,
          ReturnConsumedCapacity: 'TOTAL',
          TableName: AGENTS_DB,
      }, (err, data) => {
          if (err) {
              reject(err);
          } else {
              resolve(data);
          }
      });
  });
}

export function getAgent(id) {
    return new Promise((resolve, reject) => {
        dynamo.getItem({
            Key: { id: { S: id } },
            TableName: AGENTS_DB,
        }, (err, data) => {
            if (err) {
                reject(err);
            } else {
                if (!data.Item) {
                    reject(new Error(`Agent not found: ${id}`));
                } else {
                    resolve(data.Item);
                }
            }
        });
    });
}
