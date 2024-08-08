pipeline {
    agent any

    environment {
        DOCKER_HUB_CREDENTIALS = credentials('docker_hub_cred')
    }

    stages {
        stage('Pull Code') {
            steps {
                git 'https://github.com/YevhenTrambai/test-step2.git'
            }
        }

        stage('Build Docker Image') {
            agent {
                label 'jenkins-worker'
            }
            steps {
                script {
                    docker.build('test-image-step2')
                }
            }
        }

        stage('Run Tests') {
            agent {
                label 'jenkins-worker'
            }
            steps {
                script {
                    def app = docker.image('test-image-step2')
                    app.inside {
                        sh 'npm install'
                        sh 'npm test'
                    }
                }
            }
        }

        stage('Push to Docker Hub') {
            when {
                expression {
                    currentBuild.result == null || currentBuild.result == 'SUCCESS'
                }
            }
            steps {
                script {
                    docker.withRegistry('https://index.docker.io/v1/', 'DOCKER_HUB_CREDENTIALS') {
                        docker.image('test-image-step2').push('latest')
                    }
                }
            }
        }
    }

    post {
        failure {
            echo 'Tests failed'
        }
    }
}
