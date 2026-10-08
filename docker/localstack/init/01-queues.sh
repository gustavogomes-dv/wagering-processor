#!/bin/bash
set -e

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"

awslocal sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$DLQ_NAME" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > /tmp/main-attrs.json <<EOF
{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"}
EOF

awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes file:///tmp/main-attrs.json

echo "Filas criadas:"
awslocal sqs list-queues