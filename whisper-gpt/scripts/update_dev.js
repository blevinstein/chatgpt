
const child_process = require('child_process');

const cluster = 'whisper-gpt-cluster-dev';

// aws ecs list-services --cluster whisper-gpt-cluster-dev | jq .serviceArns[0]

async function main() {
    const serviceArn =
        JSON.parse(child_process.execSync(`aws ecs list-services --cluster ${cluster}`)).serviceArns[0];
    const serviceName = serviceArn.match(/\/([\w-]*)$/)[1];
    console.log(child_process.execSync(`aws ecs update-service --cluster ${cluster} --service ${serviceName} --force-new-deployment`, { encoding: 'utf-8' }));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
