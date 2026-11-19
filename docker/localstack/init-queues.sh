#!/bin/sh
set -eu

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT="000000000000"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wagering-events.fifo"
DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${DLQ_NAME}"

awslocal sqs create-queue --queue-name "$DLQ_NAME" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

awslocal sqs create-queue --queue-name "$QUEUE_NAME" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue --queue-name "$EVENTS_QUEUE_NAME" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false
