import AWS from 'aws-sdk';
import dotenv from 'dotenv';

dotenv.config();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const polly = new AWS.Polly();

export const LOGS_BUCKET = 'whisper-gpt-logs';
export const IMAGE_BUCKET = 'whisper-gpt-generated';

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
