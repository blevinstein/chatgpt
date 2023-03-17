#!/usr/bin/env bash

set -e

docker tag whisper-gpt-dev:latest $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/whisper-gpt-dev:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/whisper-gpt-dev:latest

